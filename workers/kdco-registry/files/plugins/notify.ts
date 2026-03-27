/**
 * notify
 * Native OS notifications for OpenCode
 *
 * Philosophy: "Notify the human when the AI needs them back, not for every micro-event."
 *
 * Features:
 * - Uses cmux native notifications when running inside cmux
 * - Auto-detects terminal emulator (Ghostty, Kitty, iTerm, WezTerm, etc.)
 * - Suppresses notifications when terminal is focused (like Ghostty does)
 * - Click notification to focus terminal
 * - Parent session only by default (no spam from sub-tasks)
 *
 * Uses cmux CLI first (if available), then node-notifier fallback:
 * - cmux: `cmux notify --title ... --subtitle ... --body ...`
 * - macOS: terminal-notifier (native NSUserNotificationCenter)
 * - Windows: SnoreToast (native toast notifications)
 * - Linux: notify-send (native desktop notifications)
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
// @ts-expect-error - installed at runtime by OCX
import detectTerminal from "detect-terminal"
// @ts-expect-error - installed at runtime by OCX
import notifier from "node-notifier"
import type { OpencodeClient } from "./kdco-primitives/types"
import { sendNotificationWithFallback } from "./notify/backend"
import { canUseCmuxNotification, sendCmuxNotification } from "./notify/cmux"
import {
	canUseFreedesktopNotification,
	type FreedesktopHintValue,
	getFreedesktopCapabilities,
	sendFreedesktopNotification,
} from "./notify/freedesktop"

type NotifyEventKind = "idle" | "error" | "permission" | "question"
type LinuxNotificationBackend = "auto" | "freedesktop" | "node-notifier"
type SessionNamePlacement = "summary" | "body"
type LinuxSoundMode = "name" | "file" | "off"
type LinuxUrgency = "low" | "normal" | "critical"

type EventSoundMap = {
	idle: string
	error: string
	permission: string
	question?: string
}

type EventNumberMap = Partial<Record<NotifyEventKind, number>>
type EventBooleanMap = Partial<Record<NotifyEventKind, boolean>>
type EventStringMap = Partial<Record<NotifyEventKind, string>>
type EventUrgencyMap = Partial<Record<NotifyEventKind, LinuxUrgency>>

interface LinuxLocalSoundPlaybackConfig {
	enabled: boolean
	command: string
}

interface LinuxNotifyConfig {
	backend: LinuxNotificationBackend
	sessionNamePlacement: SessionNamePlacement
	timeoutMs: EventNumberMap
	persistent: EventBooleanMap
	urgency: EventUrgencyMap
	soundMode: LinuxSoundMode
	soundNames: EventStringMap
	soundFiles: EventStringMap
	localSoundPlayback: LinuxLocalSoundPlaybackConfig
}

interface NotifyConfig {
	/** Notify for child/sub-session events (default: false) */
	notifyChildSessions: boolean
	/** Sound configuration per event type */
	sounds: EventSoundMap
	/** Quiet hours configuration */
	quietHours: {
		enabled: boolean
		start: string // "HH:MM" format
		end: string // "HH:MM" format
	}
	/** Linux/freedesktop-specific options */
	linux: LinuxNotifyConfig
	/** Override terminal detection (optional) */
	terminal?: string
}

interface TerminalInfo {
	name: string | null
	bundleId: string | null
	processName: string | null
}

const DEFAULT_CONFIG: NotifyConfig = {
	notifyChildSessions: false,
	sounds: {
		idle: "Glass",
		error: "Basso",
		permission: "Submarine",
	},
	quietHours: {
		enabled: false,
		start: "22:00",
		end: "08:00",
	},
	linux: {
		backend: "auto",
		sessionNamePlacement: "summary",
		timeoutMs: {
			idle: -1,
			error: -1,
			permission: 0,
			question: 0,
		},
		persistent: {
			permission: true,
			question: true,
		},
		urgency: {
			idle: "normal",
			error: "critical",
			permission: "critical",
			question: "normal",
		},
		soundMode: "name",
		soundNames: {
			idle: "message",
			error: "dialog-error",
			permission: "message-new-instant",
			question: "message-new-instant",
		},
		soundFiles: {},
		localSoundPlayback: {
			enabled: false,
			command: "paplay",
		},
	},
}

// Terminal name to macOS process name mapping (for focus detection)
const TERMINAL_PROCESS_NAMES: Record<string, string> = {
	ghostty: "Ghostty",
	kitty: "kitty",
	iterm: "iTerm2",
	iterm2: "iTerm2",
	wezterm: "WezTerm",
	alacritty: "Alacritty",
	terminal: "Terminal",
	apple_terminal: "Terminal",
	hyper: "Hyper",
	warp: "Warp",
	vscode: "Code",
	"vscode-insiders": "Code - Insiders",
}

// ==========================================
// CONFIGURATION
// ==========================================

async function loadConfig(): Promise<NotifyConfig> {
	const configPath = path.join(os.homedir(), ".config", "opencode", "kdco-notify.json")

	try {
		const content = await fs.readFile(configPath, "utf8")
		const userConfig = JSON.parse(content) as Partial<NotifyConfig>

		// Merge with defaults
		return {
			...DEFAULT_CONFIG,
			...userConfig,
			sounds: {
				...DEFAULT_CONFIG.sounds,
				...userConfig.sounds,
			},
			quietHours: {
				...DEFAULT_CONFIG.quietHours,
				...userConfig.quietHours,
			},
			linux: {
				...DEFAULT_CONFIG.linux,
				...userConfig.linux,
				timeoutMs: {
					...DEFAULT_CONFIG.linux.timeoutMs,
					...userConfig.linux?.timeoutMs,
				},
				persistent: {
					...DEFAULT_CONFIG.linux.persistent,
					...userConfig.linux?.persistent,
				},
				urgency: {
					...DEFAULT_CONFIG.linux.urgency,
					...userConfig.linux?.urgency,
				},
				soundNames: {
					...DEFAULT_CONFIG.linux.soundNames,
					...userConfig.linux?.soundNames,
				},
				soundFiles: {
					...DEFAULT_CONFIG.linux.soundFiles,
					...userConfig.linux?.soundFiles,
				},
				localSoundPlayback: {
					...DEFAULT_CONFIG.linux.localSoundPlayback,
					...userConfig.linux?.localSoundPlayback,
				},
			},
		}
	} catch {
		// Config doesn't exist or is invalid, use defaults
		return DEFAULT_CONFIG
	}
}

// ==========================================
// TERMINAL DETECTION (macOS)
// ==========================================

async function runOsascript(script: string): Promise<string | null> {
	if (process.platform !== "darwin") return null

	try {
		const proc = Bun.spawn(["osascript", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		})
		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

async function getBundleId(appName: string): Promise<string | null> {
	return runOsascript(`id of application "${appName}"`)
}

async function getFrontmostApp(): Promise<string | null> {
	return runOsascript(
		'tell application "System Events" to get name of first application process whose frontmost is true',
	)
}

async function detectTerminalInfo(config: NotifyConfig): Promise<TerminalInfo> {
	// Use config override if provided
	const terminalName = config.terminal || detectTerminal() || null

	if (!terminalName) {
		return { name: null, bundleId: null, processName: null }
	}

	// Get process name for focus detection
	const processName = TERMINAL_PROCESS_NAMES[terminalName.toLowerCase()] || terminalName

	// Dynamically get bundle ID from macOS (no hardcoding!)
	const bundleId = await getBundleId(processName)

	return {
		name: terminalName,
		bundleId,
		processName,
	}
}

async function isTerminalFocused(terminalInfo: TerminalInfo): Promise<boolean> {
	if (!terminalInfo.processName) return false
	if (process.platform !== "darwin") return false

	const frontmost = await getFrontmostApp()
	if (!frontmost) return false

	// Case-insensitive comparison
	return frontmost.toLowerCase() === terminalInfo.processName.toLowerCase()
}

// ==========================================
// QUIET HOURS CHECK
// ==========================================

function isQuietHours(config: NotifyConfig): boolean {
	if (!config.quietHours.enabled) return false

	const now = new Date()
	const currentMinutes = now.getHours() * 60 + now.getMinutes()

	const [startHour, startMin] = config.quietHours.start.split(":").map(Number)
	const [endHour, endMin] = config.quietHours.end.split(":").map(Number)

	const startMinutes = startHour * 60 + startMin
	const endMinutes = endHour * 60 + endMin

	// Handle overnight quiet hours (e.g., 22:00 - 08:00)
	if (startMinutes > endMinutes) {
		return currentMinutes >= startMinutes || currentMinutes < endMinutes
	}

	return currentMinutes >= startMinutes && currentMinutes < endMinutes
}

// ==========================================
// PARENT SESSION DETECTION
// ==========================================

function truncateSessionTitle(title: string | undefined): string | null {
	if (!title) return null

	const normalizedTitle = title.trim()
	if (!normalizedTitle) return null

	return normalizedTitle.slice(0, 50)
}

async function getSessionMetadata(
	client: OpencodeClient,
	sessionID: string,
): Promise<SessionMetadata> {
	try {
		const session = await client.session.get({ path: { id: sessionID } })
		return {
			isParent: !session.data?.parentID,
			title: truncateSessionTitle(session.data?.title),
		}
	} catch {
		return {
			isParent: true,
			title: null,
		}
	}
}

// ==========================================
// NOTIFICATION SENDER
// ==========================================

interface NotificationOptions {
	title: string
	message: string
	subtitle?: string
	cmuxBody?: string
	sound: string
	freedesktopSummary?: string
	freedesktopBody?: string
	freedesktopHints?: Record<string, FreedesktopHintValue>
	freedesktopTimeoutMs?: number
	freedesktopReplaceKey?: string
	linuxLocalSoundFile?: string
	terminalInfo: TerminalInfo
}

interface NotificationRuntime {
	preferCmux: boolean
	preferFreedesktop: boolean
	freedesktopSupportsSound: boolean
	freedesktopNotificationIDs: Map<string, number>
	linuxLocalSoundCommand: string | null
}

interface SessionMetadata {
	isParent: boolean
	title: string | null
}

const QUESTION_DEDUPE_WINDOW_MS = 1500
const READY_DEDUPE_WINDOW_MS = 1500
const PERMISSION_DEDUPE_WINDOW_MS = 1500
const QUESTION_FALLBACK_DELAY_MS = 50

type RecentNotifications = Map<string, number>
type PendingQuestionNotifications = Map<string, PendingQuestionNotification>

interface PendingQuestionNotification {
	sessionID: string
	createdAt: number
	timeoutID: ReturnType<typeof setTimeout>
}

function toNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null

	const normalized = value.trim()
	if (!normalized) return null

	return normalized
}

function shouldSendDedupedNotification(
	recentNotifications: RecentNotifications,
	dedupeKey: string,
	windowMs: number,
	nowMs = Date.now(),
): boolean {
	for (const [key, timestamp] of recentNotifications) {
		if (nowMs - timestamp >= windowMs) {
			recentNotifications.delete(key)
		}
	}

	const lastSentAt = recentNotifications.get(dedupeKey)
	if (lastSentAt !== undefined && nowMs - lastSentAt < windowMs) {
		return false
	}

	recentNotifications.set(dedupeKey, nowMs)
	return true
}

function buildQuestionToolDedupeKey(sessionID: unknown, callID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	const normalizedCallID = toNonEmptyString(callID)
	if (!normalizedCallID) return null

	return `question:${normalizedSessionID}:${normalizedCallID}`
}

function cancelPendingQuestionNotification(
	pendingQuestions: PendingQuestionNotifications,
	questionKey: string,
): void {
	const pendingQuestion = pendingQuestions.get(questionKey)
	if (!pendingQuestion) return

	clearTimeout(pendingQuestion.timeoutID)
	pendingQuestions.delete(questionKey)
}

function consumePendingQuestionNotification(
	pendingQuestions: PendingQuestionNotifications,
	sessionID: string,
	callID: string | null,
): string | null {
	if (callID) {
		const exactKey = buildQuestionToolDedupeKey(sessionID, callID)
		if (exactKey && pendingQuestions.has(exactKey)) {
			cancelPendingQuestionNotification(pendingQuestions, exactKey)
			return exactKey
		}
	}

	let fallbackEntry: [string, PendingQuestionNotification] | null = null
	for (const entry of pendingQuestions.entries()) {
		const [, pendingQuestion] = entry
		if (pendingQuestion.sessionID !== sessionID) continue

		if (!fallbackEntry || pendingQuestion.createdAt < fallbackEntry[1].createdAt) {
			fallbackEntry = entry
		}
	}

	if (!fallbackEntry) return null

	cancelPendingQuestionNotification(pendingQuestions, fallbackEntry[0])
	return fallbackEntry[0]
}

function buildQuestionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedSessionID = toNonEmptyString(record.sessionID)
	if (!normalizedSessionID) return null

	const toolInfo =
		record.tool && typeof record.tool === "object"
			? (record.tool as Record<string, unknown>)
			: undefined
	const normalizedCallID = toNonEmptyString(toolInfo?.callID)
	if (normalizedCallID) {
		return `question:${normalizedSessionID}:${normalizedCallID}`
	}

	const normalizedRequestID = toNonEmptyString(record.id)
	if (normalizedRequestID) {
		return `question:${normalizedSessionID}:request:${normalizedRequestID}`
	}

	return null
}

function buildSessionReadyDedupeKey(sessionID: unknown): string | null {
	const normalizedSessionID = toNonEmptyString(sessionID)
	if (!normalizedSessionID) return null

	return `session-ready:${normalizedSessionID}`
}

function buildPermissionEventDedupeKey(properties: unknown): string | null {
	if (!properties || typeof properties !== "object") return null

	const record = properties as Record<string, unknown>
	const normalizedRequestID = toNonEmptyString(record.id)
	if (!normalizedRequestID) return null

	return `permission:request:${normalizedRequestID}`
}

function shouldUseFreedesktopBackend(config: NotifyConfig, backendAvailable: boolean): boolean {
	if (!backendAvailable) return false
	if (process.platform !== "linux") return false

	return config.linux.backend !== "node-notifier"
}

function getLinuxTimeoutMs(config: NotifyConfig, kind: NotifyEventKind): number {
	return config.linux.timeoutMs[kind] ?? DEFAULT_CONFIG.linux.timeoutMs[kind] ?? -1
}

function getLinuxUrgencyByte(config: NotifyConfig, kind: NotifyEventKind): number {
	const urgency = config.linux.urgency[kind] ?? DEFAULT_CONFIG.linux.urgency[kind] ?? "normal"

	switch (urgency) {
		case "low":
			return 0
		case "critical":
			return 2
		default:
			return 1
	}
}

function buildFreedesktopHints(
	config: NotifyConfig,
	kind: NotifyEventKind,
	runtime: NotificationRuntime,
): Record<string, FreedesktopHintValue> {
	const hints: Record<string, FreedesktopHintValue> = {
		urgency: {
			kind: "byte",
			value: getLinuxUrgencyByte(config, kind),
		},
		transient: {
			kind: "boolean",
			value: !config.linux.persistent[kind],
		},
	}

	if (config.linux.persistent[kind]) {
		hints.resident = {
			kind: "boolean",
			value: true,
		}
	}

	if (!runtime.freedesktopSupportsSound) {
		return hints
	}

	if (config.linux.soundMode === "off") {
		hints["suppress-sound"] = {
			kind: "boolean",
			value: true,
		}
		return hints
	}

	const soundFile = config.linux.soundFiles[kind]
	if (soundFile) {
		hints["sound-file"] = {
			kind: "string",
			value: soundFile,
		}
		return hints
	}

	if (config.linux.soundMode === "file") {
		return hints
	}

	const soundName = config.linux.soundNames[kind]
	if (soundName) {
		hints["sound-name"] = {
			kind: "string",
			value: soundName,
		}
	}

	return hints
}

function canUseLocalLinuxSoundPlayback(
	config: NotifyConfig,
	platform = process.platform,
	resolveExecutable: (command: string) => string | null | undefined = (command) =>
		Bun.which(command),
): string | null {
	if (platform !== "linux") return null
	if (!config.linux.localSoundPlayback.enabled) return null

	const command = config.linux.localSoundPlayback.command.trim()
	if (!command) return null

	return resolveExecutable(command) ? command : null
}

function playLinuxSoundFile(command: string, soundFile: string): void {
	if (!soundFile.trim()) return

	try {
		Bun.spawn([command, soundFile], {
			stdout: "ignore",
			stderr: "ignore",
		})
	} catch {
		// best effort local playback only
	}
}

async function getOptionalSessionTitle(
	client: OpencodeClient,
	sessionID: string | null | undefined,
): Promise<string | null> {
	if (!sessionID) return null

	const sessionMetadata = await getSessionMetadata(client, sessionID)
	return sessionMetadata.title
}

function sendNodeNotification(options: NotificationOptions): void {
	const { title, message, sound, terminalInfo } = options

	// Base notification options
	const notifyOptions: Record<string, unknown> = {
		title,
		message,
		sound,
	}

	// macOS-specific: click notification to focus terminal
	if (process.platform === "darwin" && terminalInfo.bundleId) {
		notifyOptions.activate = terminalInfo.bundleId
	}

	notifier.notify(notifyOptions)
}

async function sendNotification(
	options: NotificationOptions,
	runtime: NotificationRuntime,
): Promise<void> {
	await sendNotificationWithFallback({
		backends: [
			...(runtime.preferCmux
				? [
						{
							kind: "cmux",
							send: () =>
								sendCmuxNotification({
									title: options.title,
									subtitle: options.subtitle,
									body: options.cmuxBody ?? options.message,
								}),
						},
					]
				: []),
			...(runtime.preferFreedesktop
				? [
						{
							kind: "freedesktop",
							send: async () => {
								const replaceID = options.freedesktopReplaceKey
									? (runtime.freedesktopNotificationIDs.get(options.freedesktopReplaceKey) ?? 0)
									: 0
								const result = await sendFreedesktopNotification({
									summary: options.freedesktopSummary ?? options.title,
									body: options.freedesktopBody ?? options.message,
									replaceID,
									timeoutMs: options.freedesktopTimeoutMs,
									hints: options.freedesktopHints,
								})

								if (
									result.sent &&
									result.notificationID !== null &&
									options.freedesktopReplaceKey
								) {
									runtime.freedesktopNotificationIDs.set(
										options.freedesktopReplaceKey,
										result.notificationID,
									)
								}

								return result.sent
							},
						},
					]
				: []),
		],
		fallback: () => sendNodeNotification(options),
	})

	if (runtime.linuxLocalSoundCommand && options.linuxLocalSoundFile) {
		playLinuxSoundFile(runtime.linuxLocalSoundCommand, options.linuxLocalSoundFile)
	}
}

// ==========================================
// EVENT HANDLERS
// ==========================================

async function handleSessionIdle(
	client: OpencodeClient,
	sessionID: string,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	const sessionMetadata = await getSessionMetadata(client, sessionID)

	// Check if we should notify for this session
	if (!config.notifyChildSessions && !sessionMetadata.isParent) {
		return
	}

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	const sessionTitle = sessionMetadata.title ?? "Task"

	await sendNotification(
		{
			title: "Ready for review",
			message: sessionTitle,
			subtitle: sessionTitle,
			cmuxBody: "OpenCode task is ready for review",
			sound: config.sounds.idle,
			freedesktopSummary:
				config.linux.sessionNamePlacement === "summary" ? sessionTitle : "Ready for review",
			freedesktopBody:
				config.linux.sessionNamePlacement === "summary" ? "Ready for review" : sessionTitle,
			freedesktopHints: buildFreedesktopHints(config, "idle", notificationRuntime),
			freedesktopTimeoutMs: getLinuxTimeoutMs(config, "idle"),
			freedesktopReplaceKey: `session-ready:${sessionID}`,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleSessionError(
	client: OpencodeClient,
	sessionID: string,
	error: string | undefined,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	const sessionMetadata = await getSessionMetadata(client, sessionID)

	// Check if we should notify for this session
	if (!config.notifyChildSessions && !sessionMetadata.isParent) {
		return
	}

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	const errorMessage = error?.slice(0, 100) || "Something went wrong"
	const sessionTitle = sessionMetadata.title ?? "Something went wrong"

	await sendNotification(
		{
			title: "Something went wrong",
			message: errorMessage,
			sound: config.sounds.error,
			freedesktopSummary:
				config.linux.sessionNamePlacement === "summary" ? sessionTitle : errorMessage,
			freedesktopBody:
				config.linux.sessionNamePlacement === "summary" ? errorMessage : sessionTitle,
			freedesktopHints: buildFreedesktopHints(config, "error", notificationRuntime),
			freedesktopTimeoutMs: getLinuxTimeoutMs(config, "error"),
			freedesktopReplaceKey: `session-error:${sessionID}`,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handlePermissionUpdated(
	client: OpencodeClient,
	sessionID: string | null,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Always notify for permission events - AI is blocked waiting for human
	// No parent check needed: permissions always need human attention

	// Check quiet hours
	if (isQuietHours(config)) return

	// Check if terminal is focused (suppress notification if user is already looking)
	if (await isTerminalFocused(terminalInfo)) return

	const sessionTitle = (await getOptionalSessionTitle(client, sessionID)) ?? "Waiting for you"

	await sendNotification(
		{
			title: "Waiting for you",
			message: "OpenCode needs your input",
			sound: config.sounds.permission,
			freedesktopSummary:
				config.linux.sessionNamePlacement === "summary"
					? sessionTitle
					: "OpenCode needs your input",
			freedesktopBody:
				config.linux.sessionNamePlacement === "summary"
					? "OpenCode needs your input"
					: sessionTitle,
			freedesktopHints: buildFreedesktopHints(config, "permission", notificationRuntime),
			freedesktopTimeoutMs: getLinuxTimeoutMs(config, "permission"),
			freedesktopReplaceKey: sessionID ? `permission:${sessionID}` : undefined,
			terminalInfo,
		},
		notificationRuntime,
	)
}

async function handleQuestionAsked(
	client: OpencodeClient,
	sessionID: string | null,
	config: NotifyConfig,
	terminalInfo: TerminalInfo,
	notificationRuntime: NotificationRuntime,
): Promise<void> {
	// Guard: quiet hours only (no focus check for questions - tmux workflow)
	if (isQuietHours(config)) return

	const sound = config.sounds.question ?? config.sounds.permission
	const sessionTitle = (await getOptionalSessionTitle(client, sessionID)) ?? "Question for you"
	const linuxLocalSoundFile = config.linux.soundFiles.question

	await sendNotification(
		{
			title: sessionTitle,
			message: "OpenCode needs your input",
			sound,
			freedesktopSummary:
				config.linux.sessionNamePlacement === "summary"
					? sessionTitle
					: "OpenCode needs your input",
			freedesktopBody:
				config.linux.sessionNamePlacement === "summary"
					? "OpenCode needs your input"
					: sessionTitle,
			freedesktopHints: buildFreedesktopHints(config, "question", notificationRuntime),
			freedesktopTimeoutMs: getLinuxTimeoutMs(config, "question"),
			freedesktopReplaceKey: sessionID ? `question:${sessionID}` : undefined,
			linuxLocalSoundFile,
			terminalInfo,
		},
		notificationRuntime,
	)
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

export const NotifyPlugin: Plugin = async (ctx) => {
	const { client } = ctx

	// Load config once at startup
	const config = await loadConfig()

	// Detect terminal once at startup (cached for performance)
	const terminalInfo = await detectTerminalInfo(config)
	const freedesktopAvailable = canUseFreedesktopNotification()
	const linuxLocalSoundCommand = canUseLocalLinuxSoundPlayback(config)
	const preferFreedesktop = shouldUseFreedesktopBackend(config, freedesktopAvailable)
	const freedesktopCapabilities = preferFreedesktop ? await getFreedesktopCapabilities() : new Set()
	const notificationRuntime: NotificationRuntime = {
		preferCmux: canUseCmuxNotification(),
		preferFreedesktop,
		freedesktopSupportsSound: freedesktopCapabilities.has("sound"),
		freedesktopNotificationIDs: new Map(),
		linuxLocalSoundCommand,
	}
	const recentQuestionNotifications: RecentNotifications = new Map()
	const recentReadyNotifications: RecentNotifications = new Map()
	const recentPermissionNotifications: RecentNotifications = new Map()
	const pendingQuestionNotifications: PendingQuestionNotifications = new Map()

	const notifyQuestionIfNeeded = async (
		eventProperties: Record<string, unknown>,
	): Promise<void> => {
		const sessionID = toNonEmptyString(eventProperties.sessionID)
		if (!sessionID) return

		const toolInfo =
			eventProperties.tool && typeof eventProperties.tool === "object"
				? (eventProperties.tool as Record<string, unknown>)
				: undefined
		const toolCallID = toNonEmptyString(toolInfo?.callID)
		consumePendingQuestionNotification(pendingQuestionNotifications, sessionID, toolCallID)

		const dedupeKey = buildQuestionEventDedupeKey(eventProperties)

		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentQuestionNotifications,
				dedupeKey,
				QUESTION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handleQuestionAsked(
			client as OpencodeClient,
			sessionID,
			config,
			terminalInfo,
			notificationRuntime,
		)
	}

	const scheduleLegacyQuestionFallback = (sessionID: string, callID: string): void => {
		const dedupeKey = buildQuestionToolDedupeKey(sessionID, callID)
		if (!dedupeKey || pendingQuestionNotifications.has(dedupeKey)) return

		const timeoutID = setTimeout(async () => {
			pendingQuestionNotifications.delete(dedupeKey)

			if (
				!shouldSendDedupedNotification(
					recentQuestionNotifications,
					dedupeKey,
					QUESTION_DEDUPE_WINDOW_MS,
				)
			) {
				return
			}

			await handleQuestionAsked(
				client as OpencodeClient,
				sessionID,
				config,
				terminalInfo,
				notificationRuntime,
			)
		}, QUESTION_FALLBACK_DELAY_MS)

		pendingQuestionNotifications.set(dedupeKey, {
			sessionID,
			createdAt: Date.now(),
			timeoutID,
		})
	}

	const notifySessionReadyIfNeeded = async (sessionID: unknown): Promise<void> => {
		const normalizedSessionID = toNonEmptyString(sessionID)
		if (!normalizedSessionID) return

		const dedupeKey = buildSessionReadyDedupeKey(normalizedSessionID)
		if (!dedupeKey) return

		if (
			!shouldSendDedupedNotification(recentReadyNotifications, dedupeKey, READY_DEDUPE_WINDOW_MS)
		) {
			return
		}

		await handleSessionIdle(
			client as OpencodeClient,
			normalizedSessionID,
			config,
			terminalInfo,
			notificationRuntime,
		)
	}

	const notifyPermissionIfNeeded = async (properties: unknown): Promise<void> => {
		const dedupeKey = buildPermissionEventDedupeKey(properties)
		const sessionID =
			properties && typeof properties === "object"
				? toNonEmptyString((properties as Record<string, unknown>).sessionID)
				: null

		if (
			dedupeKey &&
			!shouldSendDedupedNotification(
				recentPermissionNotifications,
				dedupeKey,
				PERMISSION_DEDUPE_WINDOW_MS,
			)
		) {
			return
		}

		await handlePermissionUpdated(
			client as OpencodeClient,
			sessionID,
			config,
			terminalInfo,
			notificationRuntime,
		)
	}

	return {
		"tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }) => {
			if (input.tool === "question") {
				scheduleLegacyQuestionFallback(input.sessionID, input.callID)
			}
		},
		event: async ({ event }: { event: Event }): Promise<void> => {
			const runtimeEvent = event as { type: string; properties: Record<string, unknown> }

			switch (runtimeEvent.type) {
				case "session.status": {
					const sessionID = runtimeEvent.properties.sessionID
					const statusType =
						runtimeEvent.properties.status && typeof runtimeEvent.properties.status === "object"
							? ((runtimeEvent.properties.status as { type?: string }).type ?? undefined)
							: undefined

					if (sessionID && statusType === "idle") {
						await notifySessionReadyIfNeeded(sessionID)
					}
					break
				}
				case "session.idle": {
					await notifySessionReadyIfNeeded(runtimeEvent.properties.sessionID)
					break
				}
				case "session.error": {
					const sessionID = toNonEmptyString(runtimeEvent.properties.sessionID)
					const error = runtimeEvent.properties.error
					const errorMessage = typeof error === "string" ? error : error ? String(error) : undefined
					if (sessionID) {
						await handleSessionError(
							client as OpencodeClient,
							sessionID,
							errorMessage,
							config,
							terminalInfo,
							notificationRuntime,
						)
					}
					break
				}

				case "permission.updated":
				case "permission.asked": {
					await notifyPermissionIfNeeded(runtimeEvent.properties)
					break
				}
				case "question.asked": {
					await notifyQuestionIfNeeded(runtimeEvent.properties)
					break
				}
			}
		},
	}
}

export default NotifyPlugin
