# JD Payment Processor

## What this script does

This project scans a configured inbox folder for incoming payment CSV files, reads payment application rows, writes receipt batch data into SQL Server (Canopy ERP tables), and moves each successfully processed file into an archive folder.

File names must follow this format:

`{CustomerCode}_{Date}_{Time}_{CheckNumber}.csv`

Example:

`40206_20260427_161532_DCMGG2P3SH-VS.csv`

The script gets `CustomerCode` and `CheckNumber` from the file name (not from the CSV contents).

## Install

```bash
npm install
```

## Run manually

```bash
node process-payments.js
```

## Configure

Edit `config.js` and set:

- SQL Server connection credentials under `db`
- Folder locations under `paths`
- `bankAccountCode`
- `userID`

Default paths are:

- Inbox: `C:\Tabasco\data\payments\payments_to_process`
- Archive: `C:\Tabasco\data\payments\payments_to_process\archive`

## Windows Task Scheduler setup

1. Open **Task Scheduler**.
2. Click **Create Basic Task...**
3. Name it, for example: `JD Payment Processor`.
4. Choose a trigger (for example every 5 minutes).
5. Choose **Start a program**.
6. Program/script: path to `node.exe` (example: `C:\Program Files\nodejs\node.exe`).
7. Add arguments: `process-payments.js`
8. Start in: your project folder path (example: `C:\apps\jd-payment-processor`).
9. Finish and test by right-clicking the task and selecting **Run**.

## Switch from JDTest to JDFoodService

In `config.js`, change:

```js
module.exports = {
  db: {
    database: 'JDTest',
  },
};
```

to:

```js
module.exports = {
  db: {
    database: 'JDFoodService',
  },
};
```

Then run the script again.

## Required npm packages

- `mssql`
- `csv-parse`
