import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Voice notes to text, on this machine: `ffmpeg` turns Telegram's Opus into 16 kHz mono WAV and whisper.cpp's
 * `whisper-cli` transcribes it. Both run with fixed arguments (PLAN rule 5: no agent chooses what runs); only the
 * binary and model paths come from the configuration. No speech-to-text service or key is involved.
 */

/** Runs one program with fixed arguments and returns its standard output. Tests pass a fake. */
export type Runner = (
	file: string,
	args: readonly string[],
	options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

export type WhisperConfig = { bin: string; model: string };

/** Longest voice note transcribed, in seconds. */
export const MAX_VOICE_SECONDS = 5 * 60;
/** Largest voice note downloaded, in bytes (Opus at ~32 kbit/s is ~1.2 MB for 5 minutes). */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
/** The longest transcript put into the thread. */
export const MAX_TRANSCRIPT_CHARS = 8000;

export const TRANSCRIPT_LABEL = "[Voice note transcript]";

export class VoiceError extends Error {
	/** What the program said (its stderr), for the server log only; never sent to the chat. */
	readonly detail: string;
	constructor(message: string, detail = "") {
		super(message);
		this.name = "VoiceError";
		this.detail = detail;
	}
}

function stderrOf(error: unknown): string {
	const stderr = (error as { stderr?: unknown }).stderr;
	const text =
		typeof stderr === "string" && stderr.trim() !== ""
			? stderr
			: error instanceof Error
				? error.message
				: String(error);
	return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export const execRunner: Runner = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{
				timeout: options.timeoutMs,
				maxBuffer: 4 * 1024 * 1024,
				// A clean environment: the children need nothing of the server's.
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
				...(options.signal === undefined ? {} : { signal: options.signal }),
			},
			(error, stdout, stderr) =>
				error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve({ stdout: String(stdout) }),
		);
	});

export type Transcriber = (audio: Uint8Array, signal?: AbortSignal) => Promise<string>;

export function createTranscriber(options: {
	whisper: WhisperConfig;
	ffmpeg?: string;
	run?: Runner;
	tempDir?: string;
}): Transcriber {
	const run = options.run ?? execRunner;
	const ffmpeg = options.ffmpeg ?? "ffmpeg";
	return async (audio, signal) => {
		const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), "zimpoen-voice-"));
		try {
			const input = join(dir, "in.oga");
			const wav = join(dir, "in.wav");
			await writeFile(input, audio, { mode: 0o600 });
			try {
				await run(
					ffmpeg,
					[
						"-nostdin",
						"-loglevel",
						"error",
						"-y",
						// Fixed input format and protocols: ffmpeg must not probe a crafted file into a playlist that reads other local
						// files or URLs. Telegram voice notes are always Ogg/Opus.
						"-protocol_whitelist",
						"file",
						"-f",
						"ogg",
						"-i",
						input,
						"-t",
						String(MAX_VOICE_SECONDS),
						"-ar",
						"16000",
						"-ac",
						"1",
						"-c:a",
						"pcm_s16le",
						"-f",
						"wav",
						wav,
					],
					{ timeoutMs: 60_000, ...(signal === undefined ? {} : { signal }) },
				);
			} catch (error) {
				throw new VoiceError("The voice note could not be converted (is ffmpeg installed?).", stderrOf(error));
			}
			let stdout: string;
			try {
				({ stdout } = await run(
					options.whisper.bin,
					["-m", options.whisper.model, "-f", wav, "--no-timestamps", "--no-prints", "--language", "auto"],
					{ timeoutMs: 5 * 60_000, ...(signal === undefined ? {} : { signal }) },
				));
			} catch (error) {
				throw new VoiceError(
					"whisper.cpp could not transcribe the voice note. Check ZIMPOEN_WHISPER_BIN and ZIMPOEN_WHISPER_MODEL.",
					stderrOf(error),
				);
			}
			return stdout.replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_CHARS);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}
