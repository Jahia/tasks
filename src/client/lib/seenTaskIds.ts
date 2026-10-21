/**
 * What this browser has already shown the reader, for one kind of profile-icon notification.
 *
 * Per user key, not per browser profile: two people on one machine do not share a read/unread
 * state. Storage can throw outright rather than merely come back empty -- a browser set to block
 * site data raises on the accessor -- so every read and write is guarded and degrades to "no
 * notification" rather than taking the shell down with it.
 *
 * Used by closedTaskAlerts under the list name 'closed'; kept apart so another source can keep
 * its own read state under another name.
 */

const storageKey = (list: string, userKey: string) => `tasks-board-${list}-seen-${userKey}`;

/**
 * The ids already shown, or null if this browser has never recorded any.
 *
 * The null matters: on a first ever visit everything in the window would otherwise read as news.
 * Null means "start counting from now"; an empty array means "counting, nothing seen yet".
 */
export function readSeenTaskIds(list: string, userKey: string): string[] | null {
    try {
        const stored = window.localStorage.getItem(storageKey(list, userKey));
        if (stored === null) {
            return null;
        }

        const parsed: unknown = JSON.parse(stored);
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
    } catch {
        return null;
    }
}

/**
 * Marks ids as seen, keeping the most recently marked `memory` of them. Re-marking moves an id
 * back to the end, so the ones met most recently are the last to be forgotten.
 */
export function rememberSeenTaskIds(list: string, userKey: string, ids: string[], memory: number): void {
    if (ids.length === 0) {
        return;
    }

    const marked = new Set(ids);
    const kept = (readSeenTaskIds(list, userKey) ?? []).filter(id => !marked.has(id));
    try {
        window.localStorage.setItem(storageKey(list, userKey), JSON.stringify([...kept, ...ids].slice(-memory)));
    } catch {
        // Nothing to do and nothing worth saying: the badge is a convenience, and a browser that
        // will not store it still shows every task on the board.
    }
}
