const { DatabaseSync } = require('node:sqlite')
const { DeviceAuthRepository } = require('../../db/device-auth-repository')

const database = new DatabaseSync(process.argv[2])
process.send({ type: 'ready' })
process.once('message', (message) => {
  if (!message || message.type !== 'go') return
  try {
    new DeviceAuthRepository(database).initialize()
    process.send({ type: 'done', ok: true })
  } catch (error) {
    process.send({
      type: 'done',
      ok: false,
      code: error && error.code ? error.code : 'INITIALIZE_FAILED'
    })
  } finally {
    database.close()
    process.disconnect()
  }
})
