import { describe, expect, it, mock } from "bun:test"
import { sendNotificationWithFallback } from "../files/plugins/notify/backend"
import { sendCmuxNotification } from "../files/plugins/notify/cmux"

describe("notify backend fallback behavior", () => {
	it("uses node notifier directly when cmux is not preferred", async () => {
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [],
			fallback: sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("prefers cmux when cmux delivery succeeds", async () => {
		const tryCmuxNotify = mock(async () => true)
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{
					kind: "cmux",
					send: tryCmuxNotify,
				},
			],
			fallback: sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).not.toHaveBeenCalled()
	})

	it("falls back to node notifier when cmux returns false", async () => {
		const tryCmuxNotify = mock(async () => false)
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{
					kind: "cmux",
					send: tryCmuxNotify,
				},
			],
			fallback: sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux throws", async () => {
		const tryCmuxNotify = mock(async () => {
			throw new Error("cmux unavailable")
		})
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{
					kind: "cmux",
					send: tryCmuxNotify,
				},
			],
			fallback: sendNodeNotify,
		})

		expect(tryCmuxNotify).toHaveBeenCalledTimes(1)
		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux exits non-zero", async () => {
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{
					kind: "cmux",
					send: () =>
						sendCmuxNotification(
							{
								title: "Something went wrong",
								body: "Task failed",
							},
							{
								spawnProcess: () => ({
									exited: Promise.resolve(1),
								}),
							},
						),
				},
			],
			fallback: sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls back to node notifier when cmux times out", async () => {
		const sendNodeNotify = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{
					kind: "cmux",
					send: () =>
						sendCmuxNotification(
							{
								title: "Ready",
								body: "Task complete",
							},
							{
								timeoutMs: 10,
								spawnProcess: () => ({
									exited: new Promise<number>(() => {
										// Simulate hung cmux process
									}),
								}),
							},
						),
				},
			],
			fallback: sendNodeNotify,
		})

		expect(sendNodeNotify).toHaveBeenCalledTimes(1)
	})

	it("falls through multiple backend attempts before fallback", async () => {
		const firstBackend = mock(async () => false)
		const secondBackend = mock(async () => false)
		const fallback = mock(() => {})

		await sendNotificationWithFallback({
			backends: [
				{ kind: "first", send: firstBackend },
				{ kind: "second", send: secondBackend },
			],
			fallback,
		})

		expect(firstBackend).toHaveBeenCalledTimes(1)
		expect(secondBackend).toHaveBeenCalledTimes(1)
		expect(fallback).toHaveBeenCalledTimes(1)
	})
})
