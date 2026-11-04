# A04 Owner-installed verifier dependency

`vendor/JSON/PP.pm` (version 4.06) and `vendor/JSON/PP/Boolean.pm` were copied byte-for-byte on 2026-10-24 from this development Mac's `/System/Library/Perl/5.34/JSON/` distribution. They are pure Perl source, not platform binary modules. No package download or runtime installation is used.

- PP.pm SHA-256: `b256804d959880439ce3e5b82497d01c080228276ae55979d3ababee48293a89`
- PP/Boolean.pm SHA-256: `264db0a8de27d592dceb964bbaab9a05a65197855a7bfd4f10ed20d14f86f379`

The upstream copyright and license statements remain inside both original files. `JSON::PP` states copyright 2007–2016 Makamaka Hannyaharamitu, with documentation derived from JSON::XS by Marc Lehmann, and permits redistribution/modification under the same terms as Perl itself. `JSON::PP::Boolean` also uses the same terms as Perl itself. These terms are the Artistic License or GNU General Public License as distributed with Perl. The corresponding `perlartistic.pod` and `perlgpl.pod` texts from that same system distribution are vendored alongside the modules. Preserve these texts and the original notices when copying the fixture.

The A04 fixture packages these bytes and its input-derived comparison checker into one Owner-authorized verifier asset. The complete package SHA-256 and both vendor files enter the trial before/after manifest. The accepted fixed container image supplies `/usr/bin/perl` and the controlled interpreter environment. Nothing from the producer workspace is imported.

The reusable input schemas, comparison procedure and generic checker are fixture-owned. Expected results belong only to the A20 independent test oracle; they are not installed with the verifier or sent to the model.

## New source artifacts for reuse

`reuse-one.json` and `reuse-two.json` are separate deterministic public fictional headphone source sets. Every product ID, source reference, source record digest, and fact object differs from the original A20 seed and the other reuse set. Each retains a corrected older claim, an unknown battery value, ANC eligibility, and multiple comparison choices. They contain source data only, with no expected output. Per-source SHA-256 binds canonical source JSON; the input corpus digest binds the actual source fixture file bytes. The Owner installs these new immutable input artifacts for the two new primary-conversation requests.

The generic isolated Owner verifier package is unchanged and derives output from the selected input. A separate Rust test oracle consumes that same new input and checks its exact resulting artifact. This remains representative acceptance data rather than live product research.
