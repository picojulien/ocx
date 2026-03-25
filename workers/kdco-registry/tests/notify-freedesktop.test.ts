import { describe, expect, it } from "bun:test"
import {
	buildFreedesktopCapabilitiesArgs,
	buildFreedesktopNotifyArgs,
	canUseFreedesktopNotification,
	getFreedesktopCapabilities,
	sendFreedesktopNotification,
} from "../files/plugins/notify/freedesktop"

describe("notify freedesktop integration", () => {
	it("returns false when platform is not linux", () => {
		const canUse = canUseFreedesktopNotification(
			"darwin",
			{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
			() => "/usr/bin/dbus-send",
		)

		expect(canUse).toBe(false)
	})

	it("returns false when session bus is unavailable", () => {
		const canUse = canUseFreedesktopNotification("linux", {}, () => "/usr/bin/dbus-send")

		expect(canUse).toBe(false)
	})

	it("returns false when dbus-send is unavailable", () => {
		const canUse = canUseFreedesktopNotification(
			"linux",
			{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
			() => undefined,
		)

		expect(canUse).toBe(false)
	})

	it("returns true when linux session bus and dbus-send are available", () => {
		const canUse = canUseFreedesktopNotification(
			"linux",
			{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus" },
			() => "/usr/bin/dbus-send",
		)

		expect(canUse).toBe(true)
	})

	it("builds freedesktop capabilities args", () => {
		expect(buildFreedesktopCapabilitiesArgs()).toEqual([
			"dbus-send",
			"--session",
			"--dest=org.freedesktop.Notifications",
			"--type=method_call",
			"--print-reply",
			"/org/freedesktop/Notifications",
			"org.freedesktop.Notifications.GetCapabilities",
		])
	})

	it("builds freedesktop notify args with hints", () => {
		const args = buildFreedesktopNotifyArgs({
			summary: "Session A",
			body: "Ready for review",
			replaceID: 42,
			timeoutMs: 5000,
			hints: {
				"sound-name": { kind: "string", value: "message-new-instant" },
				urgency: { kind: "byte", value: 2 },
				resident: { kind: "boolean", value: true },
			},
		})

		expect(args).toEqual([
			"dbus-send",
			"--session",
			"--dest=org.freedesktop.Notifications",
			"--type=method_call",
			"--print-reply",
			"/org/freedesktop/Notifications",
			"org.freedesktop.Notifications.Notify",
			'string:"OpenCode"',
			"uint32:42",
			'string:""',
			'string:"Session A"',
			'string:"Ready for review"',
			"array:string:",
			'dict:string:variant:string:"sound-name",string:"message-new-instant",string:"urgency",byte:2,string:"resident",boolean:true',
			"int32:5000",
		])
	})

	it("parses capabilities from dbus-send output", async () => {
		const capabilities = await getFreedesktopCapabilities({
			spawnProcess: () => ({
				stdout: new Blob([
					'method return\n   array [\n      string "actions"\n      string "sound"\n   ]\n',
				]).stream(),
				exited: Promise.resolve(0),
			}),
		})

		expect([...capabilities]).toEqual(["actions", "sound"])
	})

	it("sends freedesktop notification and returns notification id", async () => {
		const commands: string[][] = []

		const result = await sendFreedesktopNotification(
			{
				summary: "Session A",
				body: "Ready for review",
			},
			{
				spawnProcess: (command) => {
					commands.push(command)
					return {
						stdout: new Blob(["method return\n   uint32 777\n"]).stream(),
						exited: Promise.resolve(0),
					}
				},
			},
		)

		expect(result).toEqual({ sent: true, notificationID: 777 })
		expect(commands).toHaveLength(1)
		expect(commands[0]?.[6]).toBe("org.freedesktop.Notifications.Notify")
	})

	it("returns false when freedesktop notify exits non-zero", async () => {
		const result = await sendFreedesktopNotification(
			{
				summary: "Session A",
				body: "Ready for review",
			},
			{
				spawnProcess: () => ({
					stdout: new Blob([""]).stream(),
					exited: Promise.resolve(1),
				}),
			},
		)

		expect(result).toEqual({ sent: false, notificationID: null })
	})
})
