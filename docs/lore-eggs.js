// League Lore's built-in easter eggs: the Live page's 10% roll (index.html)
// and the Commissioner's Lore desk (audit X #18) start from this list. Once
// a commissioner saves the desk, the Worker's list (GET /site-info `lore`)
// takes over on Live. Each is HTML: a <b> or a small attribution span.
const LORE_EGGS = [
    'Shit hurts k',
    `&ldquo;Don't do it&rdquo;<span class="stat-moment-attrib">&mdash; Jon</span>`,
    'Do my eyebrows look good',
    'Whatever happened to that rent money anyway?',
    `Flanders has <b>3*</b> championships.<span class="stat-moment-fine">*We all know one of them doesn't count</span>`,
    'Brad and Claude are the real league MVPs',
    "Don't forget to check out Flanders's franchise page. Might find something better than a Flanders's dog.",
    "Joe K is the only member with a J in their name to win a ship. Poor Joe G, Jared, Jeff, Jon, TJ, and Ja'Kris.",
    'Every member without a J in their name has managed to win a championship except Kris...',
    "Joe G's 2026 Football Game Attendance:<br>USAF: <b>1</b><br>UCF: <b>0</b>",
];
