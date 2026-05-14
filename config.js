module.exports = {
  db: {
    server: 'JDSQL01',
    database: 'JDTest',
    user: 'YOUR_DB_USER',
    password: 'YOUR_DB_PASSWORD',
    options: {
      trustServerCertificate: true,
    },
  },
  paths: {
    inbox: 'C:\\Tabasco\\data\\payments\\payments_to_process',
    archive: 'C:\\Tabasco\\data\\payments\\payments_to_process\\archive',
  },
  bankAccountCode: 321,
  userID: 'eslam',
};
