// The rules blocking, as a person or a workspace turns them on. Monitor is the default (a rule records what it would have
// stopped and lets the action run); the security corpora check what the matcher stops once a rule blocks.
export const ENFORCE = { enforce: ["protect-branches", "safe-shell", "protect-write", "protect-read"] };
