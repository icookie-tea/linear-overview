// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Error logger that never floods the journal: the first occurrence is always
// logged, afterwards at most once per interval, always with the running count,
// so a persistent failure stays visible without spamming per frame.
export function rateLimitedErrorLogger(prefix, intervalMs = 5000) {
    let count = 0;
    let lastLogMs = 0;

    return (message, error) => {
        count++;
        const nowMs = Date.now();
        if (count === 1 || nowMs - lastLogMs >= intervalMs) {
            lastLogMs = nowMs;
            console.error(`${prefix} ${message} (×${count})`, error);
        }
    };
}
