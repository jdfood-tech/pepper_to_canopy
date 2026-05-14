const fs = require('fs');
const path = require('path');
const sql = require('mssql/msnodesqlv8');
const nodemailer = require('nodemailer');
const { parse } = require('csv-parse/sync');
const config = require('./config');

const FILE_NAME_REGEX =
  /^(?<customerCode>\d{4,6})_(?<date>\d{8})_(?<time>\d{6})_(?<fileRef>[A-Z0-9]{10})\.csv$/;

function timestamp() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function logLine(level, fileName, message, fields) {
  const parts = [timestamp(), `[${level}]`];
  if (fileName) parts.push(`[${fileName}]`);
  parts.push(message);
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  const line = parts.join(' ');
  console.log(line);
  try {
    ensureDir(path.dirname(config.paths.log));
    fs.appendFileSync(config.paths.log, line + '\n');
  } catch (writeErr) {
    console.error(`Failed to write log file: ${writeErr.message}`);
  }
}

const log = {
  info:  (file, msg, fields) => logLine('INFO',  file, msg, fields),
  warn:  (file, msg, fields) => logLine('WARN',  file, msg, fields),
  error: (file, msg, fields) => logLine('ERROR', file, msg, fields),
};

async function sendAlertEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host:   config.alert.smtpHost,
    port:   config.alert.smtpPort,
    secure: config.alert.secure,
  });
  await transporter.sendMail({
    from:    config.alert.from,
    to:      config.alert.to.join(','),
    subject,
    text:    body,
  });
}

async function reportFileFailure(fileName, filePath, error) {
  log.error(fileName, error.message, { stack: error.stack });

  try {
    ensureDir(config.paths.failureShare);
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, path.join(config.paths.failureShare, fileName));
    }
  } catch (copyErr) {
    log.error(fileName, `Failed to copy to failure share: ${copyErr.message}`);
  }

  try {
    await sendAlertEmail(
      `Pepper Pay processing failed: ${fileName}`,
      [
        `File:  ${fileName}`,
        `Time:  ${timestamp()}`,
        `Error: ${error.message}`,
        '',
        'Stack:',
        error.stack || '(no stack)',
        '',
        `See log: ${config.paths.log}`,
      ].join('\n')
    );
  } catch (mailErr) {
    log.error(fileName, `Failed to send alert email: ${mailErr.message}`);
  }
}

function acquireLock() {
  const lockPath = config.paths.lock;
  ensureDir(path.dirname(lockPath));

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid} ${timestamp()}\n`);
    fs.closeSync(fd);
    return { acquired: true, takeover: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const stat = fs.statSync(lockPath);
  const ageMin = (Date.now() - stat.mtimeMs) / 60000;
  if (ageMin > config.stalelockMinutes) {
    fs.writeFileSync(lockPath, `${process.pid} ${timestamp()} (took over stale lock)\n`);
    return { acquired: true, takeover: true, staleAgeMin: ageMin };
  }

  return { acquired: false };
}

function releaseLock() {
  try {
    if (fs.existsSync(config.paths.lock)) {
      fs.unlinkSync(config.paths.lock);
    }
  } catch (err) {
    log.warn(null, `Failed to release lockfile: ${err.message}`);
  }
}

function parseFileName(fileName) {
  const match = fileName.match(FILE_NAME_REGEX);
  if (!match || !match.groups) {
    throw new Error(
      `Invalid filename format: ${fileName}. Expected {CustomerCode}_{YYYYMMDD}_{HHMMSS}_{10-char ref}.csv`
    );
  }
  return {
    customerCode: match.groups.customerCode,
    fileRef:      match.groups.fileRef,
  };
}

function splitCheckNumber(rawCheckNumber) {
  const dash = rawCheckNumber.indexOf('-');
  if (dash === -1) {
    return { prefix: rawCheckNumber, suffix: '' };
  }
  return {
    prefix: rawCheckNumber.slice(0, dash),
    suffix: rawCheckNumber.slice(dash + 1).trim(),
  };
}

function parsePaymentFile(filePath, fileName, fileRef) {
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const rows = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    delimiter: [',', '\t'],
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  if (rows.length === 0) {
    throw new Error('CSV has no data rows');
  }

  const rawCheckNumber = rows[0].CheckNumber || '';
  const { prefix, suffix } = splitCheckNumber(rawCheckNumber);

  if (prefix !== fileRef) {
    throw new Error(
      `Filename ref (${fileRef}) does not match CSV CheckNumber prefix (${prefix})`
    );
  }

  const notesFallback = suffix ? `${suffix} from Pepper Pay` : '';
  const mappedRows = [];

  rows.forEach((row, index) => {
    const lineNum = index + 2;
    const invoiceNumber = row.InvoiceNumber;
    const applyAmountValue = row.ApplyAmount;

    if (!invoiceNumber) {
      throw new Error(`Missing InvoiceNumber at row ${lineNum}`);
    }

    const applyAmount = Number(applyAmountValue);
    if (Number.isNaN(applyAmount)) {
      throw new Error(`Invalid ApplyAmount '${applyAmountValue}' at row ${lineNum}`);
    }

    if (applyAmount === 0) {
      log.warn(fileName, 'Skipping zero-amount row', { line: lineNum, invoiceNumber });
      return;
    }

    const receiptNotes = (row.ReceiptNotes || '').trim() || notesFallback;

    mappedRows.push({
      lineNum,
      invoiceNumber,
      applyAmount,
      receiptNotes,
    });
  });

  if (mappedRows.length === 0) {
    throw new Error('CSV has no non-zero payment rows to process');
  }

  const controlTotal = Number(
    mappedRows.reduce((s, r) => s + r.applyAmount, 0).toFixed(2)
  );

  return {
    checkNumber: prefix,
    notesSuffix: suffix,
    rows: mappedRows,
    controlTotal,
  };
}

async function resolveCustomerKey(transaction, customerCode) {
  const result = await transaction
    .request()
    .input('customerCode', sql.VarChar(50), customerCode)
    .query('SELECT CustomerKey FROM AR_Customers WHERE CustomerCode = @customerCode');

  if (result.recordset.length === 0) {
    throw new Error(`Customer not found for CustomerCode: ${customerCode}`);
  }
  return result.recordset[0].CustomerKey;
}

async function getNextReferenceNumber(transaction) {
  const result = await transaction.request().query(
    `SELECT ISNULL(MAX(ReferenceNumber), 0) + 1 AS NextRef
     FROM AR_BatchReceiptControl WITH (UPDLOCK, HOLDLOCK)`
  );
  return result.recordset[0].NextRef;
}

async function resolveInvoiceOrCreditMemo(transaction, invoiceNumber, customerKey) {
  const invoiceResult = await transaction
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .query('SELECT AR_InvoiceCode FROM AR_Invoices WHERE InvoiceNumber = @invoiceNumber');

  if (invoiceResult.recordset.length > 0) {
    return {
      arInvoiceCode: invoiceResult.recordset[0].AR_InvoiceCode,
      arReceiptCode: null,
      type: 'invoice',
    };
  }

  const creditMemoResult = await transaction
    .request()
    .input('invoiceNumber', sql.VarChar(50), invoiceNumber)
    .input('customerKey', sql.Int, customerKey)
    .query(
      `SELECT AR_ReceiptCode FROM AR_Receipts
       WHERE CreditMemoNumber = @invoiceNumber AND CustomerKey = @customerKey`
    );

  if (creditMemoResult.recordset.length > 0) {
    return {
      arInvoiceCode: null,
      arReceiptCode: creditMemoResult.recordset[0].AR_ReceiptCode,
      type: 'credit memo',
    };
  }

  throw new Error(`Invoice/Credit memo not found for InvoiceNumber: ${invoiceNumber}`);
}

async function insertBatch(transaction, batch) {
  await transaction
    .request()
    .input('refNum',          sql.Int,           batch.referenceNumber)
    .input('userID',          sql.VarChar(50),   config.userID)
    .input('bankAccountCode', sql.Int,           config.bankAccountCode)
    .input('batchStatusCode', sql.Int,           config.batchStatusCode)
    .input('validationAmount',sql.Decimal(18, 2),batch.controlTotal)
    .query(
      `INSERT INTO AR_BatchReceiptControl
       (ReferenceNumber, BatchStatusCode, NextEntry, UserID, BankAccountCode,
        PostingDate, ValidationAmount, PostDetailedEntriesToGL)
       VALUES (@refNum, @batchStatusCode, 2, @userID, @bankAccountCode,
               GETDATE(), @validationAmount, 0)`
    );

  await transaction
    .request()
    .input('refNum',        sql.Int,            batch.referenceNumber)
    .input('customerKey',   sql.Int,            batch.customerKey)
    .input('checkNumber',   sql.VarChar(100),   batch.checkNumber)
    .input('receiptAmount', sql.Decimal(18, 2), batch.controlTotal)
    .input('userID',        sql.VarChar(50),    config.userID)
    .input('receiptType',   sql.Int,            config.receiptType)
    .input('paymentType',   sql.Int,            config.paymentType)
    .query(
      `INSERT INTO AR_BatchReceipts
       (ReferenceNumber, EntryNumber, CustomerKey, ReceiptType, ReceiptAmount,
        Discount, Touchups, BankNumber, CheckNumber, PostedLevel, ExchangeRate,
        UserID_EnteredBy, EnteredTime, PaymentType)
       VALUES (@refNum, 1, @customerKey, @receiptType, @receiptAmount,
               0.00, 0.00, '', @checkNumber, 0, 1,
               @userID, GETDATE(), @paymentType)`
    );

  for (const row of batch.rows) {
    await transaction
      .request()
      .input('refNum',        sql.Int,            batch.referenceNumber)
      .input('arInvoiceCode', sql.Int,            row.arInvoiceCode)
      .input('arReceiptCode', sql.Int,            row.arReceiptCode)
      .input('applyAmount',   sql.Decimal(18, 2), row.applyAmount)
      .input('notes',         sql.VarChar(255),   row.receiptNotes)
      .query(
        `INSERT INTO AR_BatchReceiptDetails
         (ReferenceNumber, EntryNumber, AR_InvoiceCode, AR_ReceiptCode, Amount,
          Posted, Notes, Discount, ImportMatchMethod)
         VALUES (@refNum, 1, @arInvoiceCode, @arReceiptCode, @applyAmount,
                 0, @notes, 0.00, 0)`
      );
  }

  if (config.autoPost && config.postProcName) {
    await transaction
      .request()
      .input('refNum', sql.Int, batch.referenceNumber)
      .execute(config.postProcName);
  }
}

async function processFile(pool, fileName) {
  const filePath = path.join(config.paths.inbox, fileName);

  log.info(fileName, 'Processing started');

  const { customerCode, fileRef } = parseFileName(fileName);
  const parsed = parsePaymentFile(filePath, fileName, fileRef);

  log.info(fileName, 'Parsed', {
    customerCode,
    checkNumber: parsed.checkNumber,
    rowCount: parsed.rows.length,
    controlTotal: parsed.controlTotal,
  });

  if (config.dryRun) {
    log.info(fileName, 'DRY RUN — would insert batch', {
      customerCode,
      checkNumber: parsed.checkNumber,
      controlTotal: parsed.controlTotal,
      rows: parsed.rows.map((r) => ({
        line: r.lineNum,
        invoice: r.invoiceNumber,
        amount: r.applyAmount,
        notes: r.receiptNotes,
      })),
    });
    ensureDir(config.paths.dryrun);
    fs.renameSync(filePath, path.join(config.paths.dryrun, fileName));
    log.info(fileName, 'Moved to dryrun folder');
    return;
  }

  const transaction = new sql.Transaction(pool);
  let committed = false;
  try {
    await transaction.begin();

    const customerKey = await resolveCustomerKey(transaction, customerCode);
    const referenceNumber = await getNextReferenceNumber(transaction);

    const resolvedRows = [];
    for (const row of parsed.rows) {
      const resolution = await resolveInvoiceOrCreditMemo(
        transaction,
        row.invoiceNumber,
        customerKey
      );
      resolvedRows.push({ ...row, ...resolution });
    }

    await insertBatch(transaction, {
      referenceNumber,
      customerKey,
      checkNumber:  parsed.checkNumber,
      controlTotal: parsed.controlTotal,
      rows:         resolvedRows,
    });

    await transaction.commit();
    committed = true;

    log.info(fileName, 'Batch committed', {
      referenceNumber,
      controlTotal: parsed.controlTotal,
      rowCount: resolvedRows.length,
    });

    ensureDir(config.paths.archive);
    fs.renameSync(filePath, path.join(config.paths.archive, fileName));
    log.info(fileName, 'Archived');
  } finally {
    if (!committed && transaction._aborted !== true) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        log.error(fileName, `Rollback error: ${rollbackErr.message}`);
      }
    }
  }
}

async function drainInbox(pool) {
  ensureDir(config.paths.inbox);
  ensureDir(config.paths.archive);

  const files = fs
    .readdirSync(config.paths.inbox)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();

  if (files.length === 0) {
    log.info(null, 'No CSV files in inbox');
    return { processed: 0, failed: 0 };
  }

  log.info(null, `Found ${files.length} CSV file(s)`);

  let processed = 0;
  let failed = 0;

  for (const fileName of files) {
    const filePath = path.join(config.paths.inbox, fileName);
    try {
      await processFile(pool, fileName);
      processed += 1;
    } catch (err) {
      failed += 1;
      await reportFileFailure(fileName, filePath, err);
    }
  }

  return { processed, failed };
}

async function main() {
  const lock = acquireLock();
  if (!lock.acquired) {
    log.info(null, 'Another instance is running — exiting');
    return;
  }
  if (lock.takeover) {
    log.warn(null, 'Took over stale lockfile', { ageMinutes: lock.staleAgeMin.toFixed(1) });
  }

  log.info(null, 'Run started', {
    dryRun: config.dryRun,
    autoPost: config.autoPost,
    db: `${config.db.server}/${config.db.database}`,
  });

  let pool;
  try {
    pool = await sql.connect(config.db);
    const result = await drainInbox(pool);
    log.info(null, 'Run finished', result);
  } finally {
    if (pool) {
      try { await pool.close(); } catch (closeErr) {
        log.warn(null, `Pool close error: ${closeErr.message}`);
      }
    }
    releaseLock();
  }
}

main().catch(async (err) => {
  log.error(null, `Fatal error: ${err.message}`, { stack: err.stack });
  try {
    await sendAlertEmail(
      'Pepper Pay run FAILED (fatal)',
      `Time: ${timestamp()}\nError: ${err.message}\n\n${err.stack || ''}\n\nSee log: ${config.paths.log}`
    );
  } catch (mailErr) {
    log.error(null, `Failed to send fatal alert email: ${mailErr.message}`);
  }
  releaseLock();
  process.exitCode = 1;
});
