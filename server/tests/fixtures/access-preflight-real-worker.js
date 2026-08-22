const { runAccessPreflight } = require('../../access-preflight')
const { bootstrapSecrets } = require('../../security/secret-bootstrap')
const {
  createGithubTmpfsSecretLoaderForTest
} = require('../support/load-github-tmpfs-provider-for-test')

const databasePath = process.argv[2]
const productionDatabasePath = process.argv[3]
const bundlePath = process.argv[4]

runAccessPreflight({
  env: process.env,
  databasePath,
  productionDatabasePath,
  bootstrap: bootstrapSecrets,
  loadSecrets: createGithubTmpfsSecretLoaderForTest({
    bundlePath,
    expectedUid: process.getuid(),
    expectedGid: process.getgid()
  })
}).then((exitCode) => {
  process.exitCode = exitCode
})
