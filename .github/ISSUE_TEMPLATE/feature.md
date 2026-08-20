---
name: Feature proposal
about: Something the extension should be able to do
labels: enhancement
---

## The problem

<!-- What is hard or impossible today, from a user's point of view. Not the
solution yet. A proposal that starts at the solution usually hides a cheaper
answer. -->

## Proposal

<!-- What you would do about it. Rough is fine. -->

## Alternatives considered

<!-- Including "do nothing". If the workaround is acceptable, say why it is not. -->

## Does docs/ROADMAP.md already cover this?

<!-- Check before filing. Several ideas are already captured there with their open
questions; if this is one of them, link the item and add what is new rather than
starting a parallel discussion. -->

## Which invariants does it touch?

<!-- From CLAUDE.md. Be honest here, it decides how the idea gets designed:

- Does it need data to leave the machine? Then it cannot be built as proposed.
  Zero network egress is not negotiable; clipboard handoff or a local model are
  the available shapes.
- Does it add a new place where an untrusted string reaches the DOM?
- Does it add a new output path that has to honor the privacy flag?
- Does it change the saved-file format, which is parsed downstream?
- Does it need a new permission in the manifest? Every added permission makes
  existing users re-consent, so it needs a strong reason. -->

## Scale

<!-- Roughly how many meetings, participants or messages does this have to hold
up under? Anything touching the transcript accumulator or storage retention
needs a number, not "a lot". -->
