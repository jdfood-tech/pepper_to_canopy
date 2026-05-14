-- inspect-manual-batch.sql
--
-- Read-only diagnostic. Run this AFTER an AR user keys ONE real Pepper Pay
-- batch by hand in Canopy against the test database. The output shows every
-- column value the manual UI wrote so we can diff against what
-- process-payments.js inserts and adjust hardcoded values (BatchStatusCode,
-- PaymentType, ReceiptType, BankAccountCode, etc.) in config.js if they
-- differ.
--
-- Replace <REFNUM> with the ReferenceNumber Canopy assigned to the manual batch.

DECLARE @ref INT = <REFNUM>;

SELECT 'AR_BatchReceiptControl' AS source, *
FROM AR_BatchReceiptControl
WHERE ReferenceNumber = @ref;

SELECT 'AR_BatchReceipts' AS source, *
FROM AR_BatchReceipts
WHERE ReferenceNumber = @ref;

SELECT 'AR_BatchReceiptDetails' AS source, *
FROM AR_BatchReceiptDetails
WHERE ReferenceNumber = @ref;
