import { logger } from "@/ui/logger";

export type PendingAttachment = { data: Uint8Array; mimeType: string; name: string };

export interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean; // If true, this message must be processed alone
    /** Decoded image attachments owned by *this* message (per-message ownership). */
    attachments?: PendingAttachment[];
}

/**
 * Called the moment a message is enqueued, with the item that was enqueued.
 *
 * The item is handed over so a handler that delivers the message ITSELF can
 * take it back off the queue again (BASED-141). It used to get the text alone,
 * and the local launcher — which types a phone message straight into the tmux
 * pane — had no way to say "this one is served". The item stayed on the queue,
 * and a non-empty queue is how the launcher decides that a dead child means
 * "hand the session to remote mode", so every delivered message turned the
 * next exit into a takeover and replayed itself as a fresh headless turn.
 */
export type OnMessageHandler<T> = (message: string, mode: T, item: QueueItem<T>) => void;

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
    private onMessageHandler: OnMessageHandler<T> | null = null;
    modeHasher: (mode: T) => string;

    constructor(
        modeHasher: (mode: T) => string,
        onMessageHandler: OnMessageHandler<T> | null = null
    ) {
        this.modeHasher = modeHasher;
        this.onMessageHandler = onMessageHandler;
        logger.debug(`[MessageQueue2] Initialized`);
    }

    /**
     * Set a handler that will be called when a message arrives
     */
    setOnMessage(handler: OnMessageHandler<T> | null): void {
        this.onMessageHandler = handler;
    }

    /**
     * Push a message to the queue with a mode and an optional list of
     * attachments that travel with this message.
     */
    push(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

        const item: QueueItem<T> = {
            message,
            mode,
            modeHash,
            isolate: false,
            attachments,
        };
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode, item);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] push() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message immediately without batching delay.
     * Does not clear the queue or enforce isolation.
     */
    pushImmediate(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushImmediate() called with mode hash: ${modeHash}`);

        const item: QueueItem<T> = {
            message,
            mode,
            modeHash,
            isolate: false
        };
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode, item);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for immediate message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushImmediate() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed in complete isolation.
     * Clears any pending messages and ensures this message is never batched with others.
     * Used for special commands that require dedicated processing.
     */
    pushIsolateAndClear(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolateAndClear() called with mode hash: ${modeHash} - clearing ${this.queue.length} pending messages`);

        // Clear any pending messages to ensure this message is processed in complete isolation
        this.queue = [];

        const item: QueueItem<T> = {
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
        };
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode, item);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolateAndClear() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message that must be processed alone without discarding
     * already-queued user prompts.
     */
    pushIsolated(message: string, mode: T, attachments?: PendingAttachment[]): void {
        if (this.closed) {
            throw new Error('Cannot push to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] pushIsolated() called with mode hash: ${modeHash}`);

        const item: QueueItem<T> = {
            message,
            mode,
            modeHash,
            isolate: true,
            attachments,
        };
        this.queue.push(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode, item);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] pushIsolated() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Push a message to the beginning of the queue with a mode.
     */
    unshift(message: string, mode: T): void {
        if (this.closed) {
            throw new Error('Cannot unshift to closed queue');
        }

        const modeHash = this.modeHasher(mode);
        logger.debug(`[MessageQueue2] unshift() called with mode hash: ${modeHash}`);

        const item: QueueItem<T> = {
            message,
            mode,
            modeHash,
            isolate: false
        };
        this.queue.unshift(item);

        // Trigger message handler if set
        if (this.onMessageHandler) {
            this.onMessageHandler(message, mode, item);
        }

        // Notify waiter if any
        if (this.waiter) {
            logger.debug(`[MessageQueue2] Notifying waiter`);
            const waiter = this.waiter;
            this.waiter = null;
            waiter(true);
        }

        logger.debug(`[MessageQueue2] unshift() completed. Queue size: ${this.queue.length}`);
    }

    /**
     * Reset the queue - clears all messages and resets to empty state
     */
    reset(): void {
        logger.debug(`[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`);
        this.queue = [];
        this.closed = false;

        // Clear waiter without calling it since we're not closing
        this.waiter = null;
    }

    /**
     * Take one specific item back off the queue, by identity.
     *
     * For a handler that delivered the message on its own and must not let it
     * be served a second time. By reference rather than by text, because two
     * identical messages are two turns and only the delivered one goes.
     * Returns whether it was still there.
     */
    remove(item: QueueItem<T>): boolean {
        const at = this.queue.indexOf(item);
        if (at < 0) return false;
        this.queue.splice(at, 1);
        logger.debug(`[MessageQueue2] remove() took one delivered message. Queue size: ${this.queue.length}`);
        return true;
    }

    /**
     * Close the queue - no more messages can be pushed
     */
    close(): void {
        logger.debug(`[MessageQueue2] close() called`);
        this.closed = true;

        // Notify any waiting caller
        if (this.waiter) {
            const waiter = this.waiter;
            this.waiter = null;
            waiter(false);
        }
    }

    /**
     * Check if the queue is closed
     */
    isClosed(): boolean {
        return this.closed;
    }

    /**
     * Get the current queue size
     */
    size(): number {
        return this.queue.length;
    }

    /**
     * Wait for messages and return all messages with the same mode as a single string
     * Returns { message: string, mode: T } or null if aborted/closed
     */
    async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{ message: string, mode: T, isolate: boolean, hash: string, attachments?: PendingAttachment[] } | null> {
        // If we have messages, return them immediately
        if (this.queue.length > 0) {
            return this.collectBatch();
        }

        // If closed or already aborted, return null
        if (this.closed || abortSignal?.aborted) {
            return null;
        }

        // Wait for messages to arrive
        const hasMessages = await this.waitForMessages(abortSignal);

        if (!hasMessages) {
            return null;
        }

        return this.collectBatch();
    }

    /**
     * Collect a batch of messages with the same mode, respecting isolation requirements
     */
    private collectBatch(): { message: string, mode: T, hash: string, isolate: boolean, attachments?: PendingAttachment[] } | null {
        if (this.queue.length === 0) {
            return null;
        }

        const firstItem = this.queue[0];
        const sameModeMessages: string[] = [];
        const collectedAttachments: PendingAttachment[] = [];
        let mode = firstItem.mode;
        let isolate = firstItem.isolate ?? false;
        const targetModeHash = firstItem.modeHash;

        // If the first message requires isolation, only process it alone
        if (firstItem.isolate) {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
            if (item.attachments) collectedAttachments.push(...item.attachments);
            logger.debug(`[MessageQueue2] Collected isolated message with mode hash: ${targetModeHash}`);
        } else {
            // Collect all messages with the same mode until we hit an isolated message
            while (this.queue.length > 0 &&
                this.queue[0].modeHash === targetModeHash &&
                !this.queue[0].isolate) {
                const item = this.queue.shift()!;
                sameModeMessages.push(item.message);
                if (item.attachments) collectedAttachments.push(...item.attachments);
            }
            logger.debug(`[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`);
        }

        // Join all messages with newlines
        const combinedMessage = sameModeMessages.join('\n');

        return {
            message: combinedMessage,
            mode,
            hash: targetModeHash,
            isolate,
            attachments: collectedAttachments.length > 0 ? collectedAttachments : undefined,
        };
    }

    /**
     * Wait for messages to arrive
     */
    private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            let abortHandler: (() => void) | null = null;

            // Set up abort handler
            if (abortSignal) {
                abortHandler = () => {
                    logger.debug('[MessageQueue2] Wait aborted');
                    // Clear waiter if it's still set
                    if (this.waiter === waiterFunc) {
                        this.waiter = null;
                    }
                    resolve(false);
                };
                abortSignal.addEventListener('abort', abortHandler);
            }

            const waiterFunc = (hasMessages: boolean) => {
                // Clean up abort handler
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(hasMessages);
            };

            // Check again in case messages arrived or queue closed while setting up
            if (this.queue.length > 0) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(true);
                return;
            }

            if (this.closed || abortSignal?.aborted) {
                if (abortHandler && abortSignal) {
                    abortSignal.removeEventListener('abort', abortHandler);
                }
                resolve(false);
                return;
            }

            // Set the waiter
            this.waiter = waiterFunc;
            logger.debug('[MessageQueue2] Waiting for messages...');
        });
    }
}
