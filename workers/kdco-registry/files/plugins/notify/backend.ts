export interface NotificationBackendAttempt {
	kind: string
	send: () => Promise<boolean>
}

interface NotifyBackendOptions {
	backends: NotificationBackendAttempt[]
	fallback: () => void
}

export async function sendNotificationWithFallback(options: NotifyBackendOptions): Promise<void> {
	for (const backend of options.backends) {
		try {
			const sent = await backend.send()
			if (sent) return
		} catch {
			// Fall through to the next backend attempt.
		}
	}

	options.fallback()
}
