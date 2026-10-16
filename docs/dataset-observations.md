# Dataset observations

Dataset records are samples, not agent events. Their detail preview uses a
`Dataset` heading and keeps the physical row as the unit of inspection. Ordinary
top-level `payload` columns do not replace the sample's root fields. Raw and Copy
remain the source of truth for unknown fields and omitted preview content.

## Source shapes and interpretation

The structural observations cover text pretraining, tokenized sequences,
instruction/input/output and prompt/response/completion samples, question/answer
pairs, chosen/rejected preference branches, conversations, and classification
labels. These are observed shapes, not a claim that a training framework will
accept the sample. A record may combine shapes; the primary scene uses the fixed
priority preference, conversation, instruction, QA, classification, tokenized,
pretraining, unknown. Independent token, role and media observations still apply.

The [LLaMA-Factory data format guide](https://github.com/hiyouga/LLaMA-Factory/blob/main/data/README.md)
documents Alpaca and ShareGPT field conventions and configurable column mappings.
This projection does not load dataset configuration, guess custom mappings, or
invoke a tokenizer. OpenAI-style `messages` and ShareGPT-style `conversations`
retain their role fields and source content. Explicit `loss_weight` values are
counted as zero, positive, negative, array-valued, or invalid; they are never
derived from a role or interpreted as a measured loss.

`tokens`, `input_ids`, `labels`, and `attention_mask` report source array lengths.
Generic `tokens` may contain strings or integer IDs. ID columns require safe
integers in the inspected prefix. A literal `-100` count has no inferred mask
semantics. `token_count` and `num_tokens` remain separate source declarations.
Differences between declarations and array lengths, or between aligned ID
columns, are structural observations rather than tokenizer validation.

Target presence means a recognized source field contains a structurally nonempty
value. It does not validate answer quality, content-block meaning, preference
ranking, or suitability for training. Missing and empty targets remain separate.
When a conversation prefix omits the remainder, absence of an assistant target
is unknown rather than a false missing-target warning.

Media observations count source references in known content blocks and
`images`/`audios`/`videos` fields. They do not deduplicate references, test file
existence, fetch URLs, decode media, or evaluate accessibility. Details show these
values as inert references.

## Bounded projection API

`src/shared/dataset-analysis.ts` owns the serializable DTOs.
`src/profiles/dataset-analysis.ts` owns two pure functions:

```ts
summarizeDatasetRecord(value: unknown, parseState?: ParseState): DatasetRecordSummary
aggregateDatasetSummaries(
  records: readonly DatasetRecordSummary[],
  options: { scope: 'visible-page' | 'observed-sample'; partial?: boolean },
): DatasetSampleSummary
```

The record projection retains scene and target states, fixed issue codes, source
field paths, message/role/loss-weight counts, sequence lengths, explicit token
declarations, media reference counts, and bounded scalar categories. It carries
no body text, token values, or media addresses. Known category fields are `label`,
`category`, `split`, and `language`; scalar values longer than 80 characters are
omitted with a truncation signal.

Each record inspects at most 64 messages across all recognized conversation
containers, 32 blocks per inspected message, 512 values per sequence, and eight
source evidence paths. Content presence follows at most two object wrappers.
The detail preview independently keeps its existing 32-message limit. Neither
projection traverses arbitrary subtrees.

The aggregate inspects at most 256 provided summaries and retains the first 32
distinct values per category field. Sorting these retained buckets does not
produce an exact top-k result. Additional occurrences are counted under
`otherObservations`; this is an overflow occurrence count, not distinct
cardinality. Numeric means use incremental accumulation over nonnegative safe
counts. Actual sequence lengths and source declarations have separate
distributions and field identities.

Coverage always reports the requested and inspected record counts, invalid
records, truncation, and whether the caller marked its input partial. Scope is
explicitly the visible page or an observed sample. A page result does not prove
full-file coverage or representative sampling. Existing analysis-intent and
generation admission rules still own when a result may commit to the UI.

## Failure and fallback

Parser failures and nonobject records produce an invalid observation. Unknown
objects produce an unknown scene and retain ordinary Generic inspection.
Malformed messages, role aliases, invalid explicit counts, incomplete preference
branches and bounded-prefix exhaustion have separate fixed issue codes. No
observation rewrites the source, creates child rows, or blocks Generic fallback.

The caller must select recognized dataset records before attaching these
summaries. Agent sessions must not receive dataset unknown-scene warnings. The
projection does not own detection, file I/O, IPC, a full-file scan, or training
framework configuration.
