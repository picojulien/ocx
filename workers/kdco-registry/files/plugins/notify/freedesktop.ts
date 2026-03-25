import { TimeoutError, withTimeout } from "../kdco-primitives/with-timeout"

type ResolveExecutable = (command: string) => string | null | undefined
type EnvironmentVariables = Record<string, string | undefined>
type SpawnFreedesktopProcess = (command: string[]) => FreedesktopProcess
type FreedesktopProcess = {
	stdout?: ReadableStream | null
	exited: Promise<number>
	kill?: () => void
}

export type FreedesktopHintValue =
	| {
			kind: "string"
			value: string
	  }
	| {
			kind: "boolean"
			value: boolean
	  }
	| {
			kind: "byte"
			value: number
	  }

export interface FreedesktopNotificationPayload {
	appName?: string
	appIcon?: string
	summary: string
	body: string
	replaceID?: number
	timeoutMs?: number
	hints?: Record<string, FreedesktopHintValue>
}

export type FreedesktopNotificationResult = {
	sent: boolean
	notificationID: number | null
}

const resolveWithBunWhich: ResolveExecutable = (command) => Bun.which(command)
const spawnWithBun: SpawnFreedesktopProcess = (command) =>
	Bun.spawn(command, {
		stdout: "pipe",
		stderr: "ignore",
	})

export const FREEDESKTOP_NOTIFY_TIMEOUT_MS = 1500
export const FREEDESKTOP_CAPABILITIES_TIMEOUT_MS = 1500

function quoteFreedesktopString(value: string): string {
	const normalizedValue = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, " ")
		.replace(/\r/g, " ")
	return `"${normalizedValue}"`
}

function buildHintValueArg(value: FreedesktopHintValue): string {
	switch (value.kind) {
		case "string":
			return `string:${quoteFreedesktopString(value.value)}`
		case "boolean":
			return `boolean:${value.value ? "true" : "false"}`
		case "byte":
			return `byte:${value.value}`
	}
}

async function readProcessOutput(stdout?: ReadableStream | null): Promise<string> {
	if (!stdout) return ""
	return new Response(stdout).text()
}

function parseNotificationID(output: string): number | null {
	const match = output.match(/uint32\s+(\d+)/)
	if (!match) return null

	return Number.parseInt(match[1], 10)
}

export function canUseFreedesktopNotification(
	platform = process.platform,
	env: EnvironmentVariables = process.env,
	resolveExecutable: ResolveExecutable = resolveWithBunWhich,
): boolean {
	if (platform !== "linux") return false
	if (!env.DBUS_SESSION_BUS_ADDRESS?.trim()) return false

	return Boolean(resolveExecutable("dbus-send"))
}

export function buildFreedesktopCapabilitiesArgs(): string[] {
	return [
		"dbus-send",
		"--session",
		"--dest=org.freedesktop.Notifications",
		"--type=method_call",
		"--print-reply",
		"/org/freedesktop/Notifications",
		"org.freedesktop.Notifications.GetCapabilities",
	]
}

export async function getFreedesktopCapabilities(options?: {
	timeoutMs?: number
	spawnProcess?: SpawnFreedesktopProcess
}): Promise<Set<string>> {
	const timeoutMs = options?.timeoutMs ?? FREEDESKTOP_CAPABILITIES_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? spawnWithBun

	try {
		const proc = spawnProcess(buildFreedesktopCapabilitiesArgs())

		try {
			const [exitCode, output] = await withTimeout(
				Promise.all([proc.exited, readProcessOutput(proc.stdout)]),
				timeoutMs,
				"freedesktop capabilities timed out",
			)

			if (exitCode !== 0) {
				return new Set()
			}

			const capabilities = new Set<string>()
			for (const match of output.matchAll(/string\s+"([^"]+)"/g)) {
				capabilities.add(match[1])
			}

			return capabilities
		} catch (error) {
			if (error instanceof TimeoutError) {
				try {
					proc.kill?.()
				} catch {
					// best effort cleanup
				}
			}

			return new Set()
		}
	} catch {
		return new Set()
	}
}

export function buildFreedesktopNotifyArgs(payload: FreedesktopNotificationPayload): string[] {
	const hintEntries = Object.entries(payload.hints ?? {})
	const hintArg =
		hintEntries.length > 0
			? `dict:string:variant:${hintEntries
					.map(
						([key, value]) => `string:${quoteFreedesktopString(key)},${buildHintValueArg(value)}`,
					)
					.join(",")}`
			: "dict:string:variant:"

	return [
		"dbus-send",
		"--session",
		"--dest=org.freedesktop.Notifications",
		"--type=method_call",
		"--print-reply",
		"/org/freedesktop/Notifications",
		"org.freedesktop.Notifications.Notify",
		`string:${quoteFreedesktopString(payload.appName ?? "OpenCode")}`,
		`uint32:${payload.replaceID ?? 0}`,
		`string:${quoteFreedesktopString(payload.appIcon ?? "")}`,
		`string:${quoteFreedesktopString(payload.summary)}`,
		`string:${quoteFreedesktopString(payload.body)}`,
		"array:string:",
		hintArg,
		`int32:${payload.timeoutMs ?? -1}`,
	]
}

export async function sendFreedesktopNotification(
	payload: FreedesktopNotificationPayload,
	options?: {
		timeoutMs?: number
		spawnProcess?: SpawnFreedesktopProcess
	},
): Promise<FreedesktopNotificationResult> {
	const timeoutMs = options?.timeoutMs ?? FREEDESKTOP_NOTIFY_TIMEOUT_MS
	const spawnProcess = options?.spawnProcess ?? spawnWithBun

	try {
		const proc = spawnProcess(buildFreedesktopNotifyArgs(payload))

		try {
			const [exitCode, output] = await withTimeout(
				Promise.all([proc.exited, readProcessOutput(proc.stdout)]),
				timeoutMs,
				"freedesktop notify timed out",
			)

			if (exitCode !== 0) {
				return { sent: false, notificationID: null }
			}

			const notificationID = parseNotificationID(output)
			return {
				sent: notificationID !== null,
				notificationID,
			}
		} catch (error) {
			if (error instanceof TimeoutError) {
				try {
					proc.kill?.()
				} catch {
					// best effort cleanup
				}
			}

			return { sent: false, notificationID: null }
		}
	} catch {
		return { sent: false, notificationID: null }
	}
}
