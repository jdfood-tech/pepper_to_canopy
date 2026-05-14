# Pepper Pay → Canopy AR Automation

Imports Pepper Pay CSV drops into Canopy ERP's AR receipt batch tables
(`AR_BatchReceiptControl` → `AR_BatchReceipts` → `AR_BatchReceiptDetails`).
Designed to run **one-shot per Task Scheduler trigger** on a Windows VM, using
Windows Integrated Authentication (no SQL password on disk).

## File format

Filenames must match:

```
{CustomerCode}_{YYYYMMDD}_{HHMMSS}_{10-char alphanumeric ref}.csv
```

Example: `74520_20260512_211025_GR327ON7Q7.csv`

CSV columns (header row required):
`CustomerCode, CheckNumber, BankNumber, PaymentAmount, InvoiceNumber, ARActivityKey, IndividualDiscount, ApplyAmount, ReceiptNotes`

Each file represents **one payment**, applied across one or more invoices
(one row per invoice). The script uses:

- `InvoiceNumber` — matched against `AR_Invoices` (or `AR_Receipts.CreditMemoNumber` for credit memo applications).
- `ApplyAmount` — per-row amount applied. Negatives accepted (credit memos). Zero rows skipped with a warning.
- `CheckNumber` — split on first `-`. Prefix must equal the filename's 10-char ref and is stored in `AR_BatchReceipts.CheckNumber`. Suffix is used as a fallback for `AR_BatchReceiptDetails.Notes` (formatted `"<suffix> from Pepper Pay"`).
- `ReceiptNotes` — if present, used as the per-row Notes value (overrides the suffix fallback).
- `PaymentAmount` — ignored. It equals `sum(ApplyAmount) - Pepper fees`, so cross-checking it adds no value.

The script's control total is `sum(ApplyAmount)` and is written to both
`AR_BatchReceiptControl.ValidationAmount` and `AR_BatchReceipts.ReceiptAmount`.

## Install

```bash
npm install
```

`msnodesqlv8` has a native compile step. On the deploy VM it requires the
Microsoft ODBC Driver for SQL Server.

## Configure

Edit `config.js`. All values marked `// PLACEHOLDER` must be filled in:

- `db.server` / `db.database` — test SQL Server host\instance and database
- `paths.failureShare` — UNC path where failed files are copied for review
- `alert.smtpHost` / `alert.from` / `alert.to` — SMTP relay and recipients

Other notable flags:

| Flag | Default | Purpose |
|---|---|---|
| `dryRun` | `true` | Parse and validate but commit zero SQL. Files move to `paths.dryrun`. Flip to `false` only after the manual-batch comparison checks out. |
| `autoPost` | `false` | Phase 2 only. When `true` AND `postProcName` is set, the script `EXEC`s the proc inside the same transaction. |
| `postProcName` | `null` | Name of Canopy's batch-post stored procedure. Discover via `sql/find-post-procs.sql`. |
| `stalelockMinutes` | `30` | Lockfile considered abandoned after this many minutes. |

## Run

```bash
npm start
```

Designed to be invoked by Windows Task Scheduler on a "file created in folder"
event (preferred) or on a short polling interval. Multiple overlapping
invocations are safe: the second one detects the lockfile and exits cleanly.

## Windows Task Scheduler setup

1. Open **Task Scheduler** → **Create Task** (not "Basic Task").
2. **General** tab: name `Pepper Pay Importer`. Run as the AD service account
   (e.g. `JDFOOD\svc_pepperpay`). Check **Run whether user is logged on or not**.
3. **Triggers** tab: **New** → **On an event** → **Custom** →
   **New Event Filter**:
   - Log: `Microsoft-Windows-NTFS/Operational`
   - Source: `Ntfs`
   - Filter on the inbox folder.
   *Alternative (simpler): "Daily, repeat every 1 minute for a duration of 1 day".*
4. **Actions** tab: **New** → **Start a program**.
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `process-payments.js`
   - Start in: project folder (e.g. `C:\apps\pepper-pay`)
5. **Conditions / Settings** tabs: defaults are fine. Do **not** check "Stop
   the task if it runs longer than" — let the lockfile handle concurrency.

## Operational diagnostics

- **Logs**: `paths.log` (default `C:\Tabasco\data\payments\logs\pepperpay.log`).
  One line per event, timestamped.
- **Failed files**: copied to `paths.failureShare`, original stays in inbox
  for retry once the underlying issue is fixed.
- **Email alerts**: sent on per-file failures and on fatal run errors.

## Verifying inserts against a manual batch

Before flipping `dryRun: false`, confirm the script's hardcoded values
(`BatchStatusCode`, `PaymentType`, `ReceiptType`, `BankAccountCode`) match
what Canopy itself writes when an AR user keys a Pepper Pay batch by hand:

1. Have AR key one real Pepper Pay batch in Canopy against the **test** DB.
2. Note the `ReferenceNumber` Canopy assigned.
3. Run `sql/inspect-manual-batch.sql` with that `ReferenceNumber` substituted.
4. Diff the column values against `config.js` and the `INSERT` statements in
   `process-payments.js`. Adjust if anything differs.

## Phase 2: auto-posting

Phase 1 only stages batches. A human still has to log into Canopy and click
**Post** for the AR balance to actually move.

To wire up auto-posting:

1. Run `sql/find-post-procs.sql` against the test DB.
2. Identify the proc Canopy uses for posting AR receipt batches. Confirm by
   reading its definition (the query includes the first 4000 chars).
3. If no candidate is obvious, set up an Extended Events session filtered to
   the Canopy service account, click **Post** on a manually-keyed batch, and
   capture the proc + args from the trace.
4. Set `postProcName` in `config.js` and flip `autoPost: true`.
5. Validate end-to-end in test (with `dryRun: false`) before deploying.

## Concurrency model

- An OS lockfile (`paths.lock`) is acquired with `O_EXCL` at startup. A
  second concurrent invocation exits with code `0` and a log line.
- If the lockfile is older than `stalelockMinutes` (covers a hard-reboot
  case), the next invocation takes it over and logs a warning.
- The `SELECT MAX(ReferenceNumber) + 1` query uses `WITH (UPDLOCK, HOLDLOCK)`
  so two batches can't claim the same internal batch number even when an AR
  user is keying a manual batch at the same instant.

## Required npm packages

- `mssql` (with `msnodesqlv8` for Integrated Auth)
- `msnodesqlv8`
- `csv-parse`
- `nodemailer`
