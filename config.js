// Configuration for the Pepper Pay → Canopy AR receipt batch importer.
//
// All values marked PLACEHOLDER must be filled in before deploying to the VM.
// The script uses Windows Integrated Authentication (no SQL password on disk)
// via the msnodesqlv8 driver, so the AD service account that runs the Task
// Scheduler job must have the appropriate Canopy DB permissions.

module.exports = {
  db: {
    driver: 'msnodesqlv8',
    server: 'TESTSQL01\\TESTINSTANCE', // PLACEHOLDER — test SQL Server host\instance
    database: 'CanopyTest',            // PLACEHOLDER — test database name
    options: {
      trustedConnection: true,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  },

  paths: {
    inbox:        'C:\\Tabasco\\data\\payments\\payments_to_process',
    archive:      'C:\\Tabasco\\data\\payments\\payments_to_process\\archive',
    dryrun:       'C:\\Tabasco\\data\\payments\\payments_to_process\\dryrun',
    failureShare: '\\\\fileserver\\PepperPay\\failures', // PLACEHOLDER — UNC path
    log:          'C:\\Tabasco\\data\\payments\\logs\\pepperpay.log',
    lock:         'C:\\Tabasco\\data\\payments\\pepperpay.lock',
  },

  alert: {
    smtpHost: 'smtp.jdfood.local',           // PLACEHOLDER
    smtpPort: 25,
    secure:   false,
    from:     'pepperpay-bot@jdfood.com',    // PLACEHOLDER
    to:       ['ar-team@jdfood.com'],        // PLACEHOLDER — one or more recipients
  },

  // Hardcoded insert values. Verify against a manually-keyed Pepper Pay batch
  // captured by sql/inspect-manual-batch.sql before flipping dryRun: false.
  bankAccountCode: 321,
  userID:          'eslam',
  batchStatusCode: 200,
  paymentType:     1,
  receiptType:     1,

  // First-cutover safety: dryRun parses + validates + logs but commits no SQL.
  dryRun:           true,

  // Phase 2 auto-posting. Leave disabled until the post stored procedure is
  // discovered via sql/find-post-procs.sql (or a Profiler trace) and verified
  // end-to-end in the test environment.
  autoPost:         false,
  postProcName:     null,

  // Lockfile considered stale after this many minutes (covers a hard-rebooted VM).
  stalelockMinutes: 30,
};
