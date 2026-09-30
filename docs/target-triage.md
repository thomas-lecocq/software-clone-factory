# Target triage

The first step of the factory. A target is usually requested, not chosen; triage decides how it
will be recorded, what it will cost, what level of fidelity can honestly be promised, and where the
work goes. When the factory does choose its own target, the eliminatory criteria apply as well.

## Recording mode decides everything

Whether a human is needed to record is decided by the target (its access and its terms), not by
the tooling. In order of preference:

| Mode                                                                                      | How it is recorded                                                                                                                 | Consequence                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **a. Logic runs locally** (desktop or on-premise software, a library embedding the logic) | Scripted, in a virtual machine restored from a snapshot before each probe                                                          | Unlimited recording; the original itself becomes resettable                           |
| **b. Official test mode or sandbox**                                                      | Scripted through the official API, within its stated limits                                                                        | Unlimited within rate limits; test mode is assumed equal to live and declared as such |
| **c. Web app whose terms allow automated access**                                         | Scripted at low rate, on the factory's own account                                                                                 | Checked per target                                                                    |
| **d. Terms forbid automation**                                                            | A human performs the actions; the tooling captures traffic and screens and converts them into fixtures from a prepared probe sheet | Human seconds per fixture measured; fewer fixtures, wider bounds                      |

Automating against a clause that forbids it is excluded, whatever the volume.

## Eliminatory, when choosing a target

1. Access that lasts for the whole project, with no billing risk.
2. Logic observable from outside: computed values in responses, or on screen.
3. Output that depends only on what the probe controls: no randomness, other users or hidden
   account state; time controllable or recorded.
4. Real logic in the slice: interacting rules (calculation, ordering, rounding, thresholds, state).

## Tie-breakers, by weight

1. A preview or quote function: a pure function of its inputs, one fixture per call.
2. Documentation with worked numbers and known quirks, to seed the rule ledger.
3. A parametrisable input space, so that random probes and combinations mean something.
4. A small screen with real transitions: dependent fields, disabled controls, errors.
5. A second slice of a different logic type in the same product.
6. A secondary oracle: an official SDK pointed at the clone (API surface only), or an open-source
   system of the same domain.

## To avoid

Bot detection on every session, A/B tests, results that vary with locale or currency, real
payments, logic driven by ML or ranking.
