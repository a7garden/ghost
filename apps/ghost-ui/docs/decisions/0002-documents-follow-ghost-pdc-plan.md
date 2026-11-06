# 0002 Document editing follows the Ghost PDC adoption plan

Status: accepted, 2026-11-06. Rule: `documents.properties`.

## Decision

Project documents keep the existing Ghost document plane (`docs/pdc-adoption.md` at the
repository root): PDC 2 for new documents, PDC 1 inputs readable and never bulk-converted.
The Garden shell and controls migration does not switch the project page's editor to
`GDocumentEditor`. Replacing the editor changes how durable user documents are parsed and
patched, so it needs its own migration with a loss report and owner approval, as the
Ghost repository guidance requires.

## Replacement behavior

The project page renders the existing document list, reader and new-document form with
`@garden/ui` controls. Parsing, saving, review approval and storage are unchanged.

## Verification

Existing document tests pass unchanged in meaning; a project with documents is opened and
a document read in the running app.
