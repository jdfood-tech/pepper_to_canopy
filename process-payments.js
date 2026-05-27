const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { parse } = require('csv-parse/sync');
const config = require('./config');

const FILE_NAME_REGEX = /^(?<customerCode>[^_]+)_(?<date>\d{8})_(?<time>\d{6})_(?<checkNumber>.+)\.csv$/i;

function parseFileName(fileName) {
  const match = fileName.match(FILE_NAME_REGEX);

  if (!match || !match.groups) {
    throw new Error(
      `Invalid filename format: ${fileName}. Expected {CustomerCode}_{Date}_{Time}_{CheckNumber}.csv`
    );
  }

  return {
    customerCode: match.groups.customerCode,
    checkNumber: match.groups.checkNumber,
  };
}

function parsePaymentFile(filePath) {
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const rows = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    delimiter: [',', '\t'],
    relax_column_count: true,
    trim: true,
    bom: true,
  });

  const mappedRows = rows.map((row, index) => {
    const invoiceNumber = row.InvoiceNumber;
    const applyAmountValue = row.ApplyAmount;

    if (!invoiceNumber) {
      throw new Error(`Missing InvoiceNumber at row ${index + 2}`);
    }

    const applyAmount = Number(applyAmountValue);
    if (Number.isNaN(applyAmount)) {
      throw new Error(`Invalid ApplyAmount '${applyAmountValue}' at row ${index + 2}`);
    }

    return {
      invoiceNumber,
      applyAmount,
    };
  });

  if (mappedRows.length === 0) {
    throw new Error('CSV has no payment rows to process');
  }

  return mappedRows;
}

async function resolveCustomerKey(transaction, customerCode) {
  const result = await transaction
    .request()
    .input('customerCode', sql.VarChar(50), customerCode)
    .query('SELECT CustomerKey FROM AR_Customers WHERE LTRIM(RTRIM(CustomerCode)) = @customerCode');

  if (result.recordset.length === 0) {
    throw new Error(`Customer not found for CustomerCode: ${customerCode}`);
  }

  return result.recordset[0].CustomerKey;
}

async function getNextReferenceNumber(transaction) {
  const result = await transaction
    .request()
    .query('SELECT ISNULL(MAX(ReferenceNumber), 0) + 1 AS NextRef FROM AR_BatchReceiptControl');

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
      'SELECT AR_ReceiptCode FROM AR_Receipts WHERE CreditMemoNumber = @invoiceNumber AND CustomerKey = @customerKey'
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

async function processFile(pool, fileName) {
  const filePath = path.join(config.paths.inbox, fileName);
  const archivePath = path.join(config.paths.archive, fileName);

  console.log(`File found: ${fileName}`);

  const { customerCode, checkNumber } = parseFileName(fileName);
  const rows = parsePaymentFile(filePath);

  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    const customerKey = await resolveCustomerKey(transaction, customerCode);
    console.log(`Customer resolved: ${customerCode} -> CustomerKey ${customerKey}`);

    const referenceNumber = await getNextReferenceNumber(transaction);
    console.log(`Reference number assigned: ${referenceNumber}`);

    const resolvedRows = [];
    for (const row of rows) {
      const resolution = await resolveInvoiceOrCreditMemo(transaction, row.invoiceNumber, customerKey);
      resolvedRows.push({ ...row, ...resolution });
    }

    await transaction
      .request()
      .input('refNum', sql.Int, referenceNumber)
      .input('userID', sql.VarChar(50), config.userID)
      .input('bankAccountCode', sql.Int, config.bankAccountCode)
      .query(
        `INSERT INTO AR_BatchReceiptControl
         (ReferenceNumber, BatchStatusCode, NextEntry, UserID, BankAccountCode, PostingDate, ValidationAmount, PostDetailedEntriesToGL)
         VALUES (@refNum, 200, 2, @userID, @bankAccountCode, GETDATE(), 0.00, 0)`
      );

    await transaction
      .request()
      .input('refNum', sql.Int, referenceNumber)
      .input('customerKey', sql.Int, customerKey)
      .input('checkNumber', sql.VarChar(100), checkNumber)
      .input('userID', sql.VarChar(50), config.userID)
      .query(
        `INSERT INTO AR_BatchReceipts
         (ReferenceNumber, EntryNumber, CustomerKey, ReceiptType, ReceiptAmount, Discount, Touchups, BankNumber, CheckNumber, PostedLevel, ExchangeRate, UserID_EnteredBy, EnteredTime, PaymentType)
         VALUES (@refNum, 1, @customerKey, 1, 0.00, 0.00, 0.00, '', @checkNumber, 0, 1, @userID, GETDATE(), 1)`
      );

    let insertedRows = 0;
    for (const row of resolvedRows) {
      await transaction
        .request()
        .input('refNum', sql.Int, referenceNumber)
        .input('arInvoiceCode', sql.Int, row.arInvoiceCode)
        .input('arReceiptCode', sql.Int, row.arReceiptCode)
        .input('applyAmount', sql.Decimal(18, 2), row.applyAmount)
        .query(
          `INSERT INTO AR_BatchReceiptDetails
           (ReferenceNumber, EntryNumber, AR_InvoiceCode, AR_ReceiptCode, Amount, Posted, Notes, Discount, ImportMatchMethod)
           VALUES (@refNum, 1, @arInvoiceCode, @arReceiptCode, @applyAmount, 0, '', 0.00, 0)`
        );
      insertedRows += 1;
    }

    await transaction.commit();
    console.log(`Rows inserted: ${insertedRows}`);

    fs.renameSync(filePath, archivePath);
    console.log(`File archived: ${archivePath}`);
  } catch (error) {
    if (transaction._aborted !== true) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        console.error(`Rollback error for file ${fileName}: ${rollbackError.message}`);
      }
    }

    console.error(`Error processing file ${fileName}: ${error.message}`);
  }
}

async function main() {
  if (!fs.existsSync(config.paths.inbox)) {
    throw new Error(`Inbox folder does not exist: ${config.paths.inbox}`);
  }

  if (!fs.existsSync(config.paths.archive)) {
    fs.mkdirSync(config.paths.archive, { recursive: true });
  }

  const files = fs
    .readdirSync(config.paths.inbox)
    .filter((file) => file.toLowerCase().endsWith('.csv'))
    .sort();

  if (files.length === 0) {
    console.log('No CSV files to process.');
    return;
  }

  const fileToProcess = files[0];
  const remaining = files.length - 1;
  console.log(`Processing 1 file: ${fileToProcess} (${remaining} more left in inbox).`);

  const pool = await sql.connect(config.db);
  try {
    await processFile(pool, fileToProcess);
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exitCode = 1;
});
