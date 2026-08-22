const fs = require('node:fs')
const { runAccessPreflight } = require('../../access-preflight')
const { bootstrapSecrets } = require('../../security/secret-bootstrap')

const databasePath = process.argv[2]
const productionDatabasePath = process.argv[3]
const markerPath = process.argv[4]
process.emitWarning('access-preflight pending worker fixture', 'ExperimentalWarning')
const versionConfig = JSON.stringify({
  adminPasswordVerifier: 'v20260822-001',
  deviceTokenHmac: {
    accepted: ['v20260822-002'],
    active: 'v20260822-002'
  }
})

runAccessPreflight({
  env: {
    KINVEST_ACCESS_CONTROL_MODE: 'device-approval',
    KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
    KINVEST_SECRET_BUNDLE_PATH: '/run/secrets/kinvest',
    KINVEST_SECRET_VERSION_IDS: versionConfig,
    KINVEST_TRUSTED_PROXY_ADDRESSES: '["127.0.0.1"]',
    KINVEST_DB_PATH: productionDatabasePath
  },
  databasePath,
  bootstrap: ({ env, signal }) => bootstrapSecrets({
    env,
    signal,
    loadSecrets: ({ signal: loaderSignal }) => new Promise((resolve, reject) => {
      void resolve
      const sensitiveBuffer = Buffer.from('pending-secret-buffer-marker')
      const keepAlive = setInterval(() => {}, 1000)
      fs.writeFileSync(markerPath, 'allocated\n')
      if (!loaderSignal) return
      const abort = () => {
        clearInterval(keepAlive)
        sensitiveBuffer.fill(0)
        fs.writeFileSync(
          markerPath,
          sensitiveBuffer.every((byte) => byte === 0) ? 'cleared\n' : 'not-cleared\n'
        )
        reject(loaderSignal.reason)
      }
      if (loaderSignal.aborted) abort()
      else loaderSignal.addEventListener('abort', abort, { once: true })
    })
  })
}).then((exitCode) => {
  process.exitCode = exitCode
})
