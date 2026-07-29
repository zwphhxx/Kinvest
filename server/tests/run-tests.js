const tests = [
  require('./refresh-policy.test'),
  require('./refresh-rules.test'),
  require('./health.test'),
  require('./build.test'),
  require('./deploy-contract.test'),
  require('./workflow-contract.test')
]

async function main() {
  let hasFailure = false

  for (const test of tests) {
    try {
      if (typeof test.run === 'function') {
        await test.run()
        console.log(`✅ ${test.run.name || 'test'} passed`)
      }
    } catch (err) {
      hasFailure = true
      console.error(`❌ ${test.run ? test.run.name || 'test' : 'unknown'} failed`, err.message)
    }
  }

  if (hasFailure) {
    process.exit(1)
  }

  console.log('All tests passed')
}

main()
