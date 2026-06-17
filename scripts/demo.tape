# Aqueduct demo recording — render with VHS (https://github.com/charmbracelet/vhs)
#
#   vhs scripts/demo.tape            # → scripts/demo.gif
#
# The demo script narrates itself (compile → serve → pay → settle); this tape just frames it with a
# title card and paces the typing. For a tight recording, pre-fund wallets and skip the faucet:
#   AQUEDUCT_SERVER_KEY=0x… AQUEDUCT_AGENT_KEY=0x… vhs scripts/demo.tape

Output scripts/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 18
Set Theme "Dracula"
Set TypingSpeed 45ms
Set PlaybackSpeed 1.0

# ── title card ────────────────────────────────────────────────────────────────
Type "# Aqueduct — any dataset becomes a metered, agent-payable data feed (MPP on Tempo)"
Enter
Sleep 1500
Type "# a raw CSV → a live Tap; an agent pays per row over a session; settles on-chain"
Enter
Sleep 2s

# ── run it ────────────────────────────────────────────────────────────────────
Type "npx tsx scripts/demo.ts"
Sleep 800ms
Enter

# Let the narrated steps play out (compile, serve, two paid calls, settle). Tune to real runtime.
Sleep 60s

Type "# ☑ a CSV became a live, agent-paid feed — real value moved on-chain"
Enter
Sleep 3s
