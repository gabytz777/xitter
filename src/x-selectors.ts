// Selectors for parts of X's own page that more than one paint script targets.

// X's relationship buttons on a profile: X names each one after the account,
// as <user id>-follow, -unfollow and so on. They sit inside X's
// placementTracking wrapper, but so does every video player, so a bare
// "placementTracking button" also catches the video's mute and play buttons.
const RELATIONS = ["follow", "unfollow", "cancel", "block", "unblock", "subscribe", "manageSubscription"];
export const RELATION_BUTTON = `button:is(${RELATIONS.map((r) => `[data-testid$="-${r}"]`).join(",")})`;
