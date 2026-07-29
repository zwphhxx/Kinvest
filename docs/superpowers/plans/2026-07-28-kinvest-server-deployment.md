# Kinvest Server Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the current Kinvest Mock frontend and API to `dearmina.cn` in a private Docker container behind the existing HTTPS Nginx, with recoverable cutover and GitHub Actions deployment from `main`.

**Architecture:** Keep the existing Nginx and Certbot stack, attach Nginx and Kinvest to an external Docker network named `web`, and expose Kinvest only inside that network on port 4173. A root-owned server script deploys an exact Git commit into an immutable release directory, builds a tagged image, performs health checks, and rolls back on failure; GitHub Actions reaches that script through a dedicated key-only deployment user.

**Tech Stack:** Node.js 22, CommonJS, node:sqlite, Docker/Compose, Nginx, Bash, GitHub Actions, ESLint, TypeScript checkJs

---

## File map

**Application runtime**

- Modify: `server/server.js` - register the health endpoint.
- Create: `server/services/health.js` - perform the SQLite and Mock-mode health check.
- Create: `server/tests/health.test.js` - verify health payload and temporary SQLite access.
- Modify: `server/tests/run-tests.js` - include new test modules.

**Quality and build**

- Modify: `package.json` - add check, lint, typecheck, build, and production start scripts.
- Create: `package-lock.json` - pin development tooling.
- Create: `eslint.config.js` - lint Node and browser JavaScript.
- Create: `jsconfig.json` - run TypeScript checkJs against server and build scripts.
- Create: `scripts/build.js` - create deterministic `dist` output.
- Create: `server/tests/build.test.js` - verify required files in `dist`.

**Container and proxy**

- Create: `.dockerignore` - exclude credentials, databases, logs, docs, and local artifacts.
- Create: `Dockerfile` - build and run the app as the unprivileged `node` user.
- Create: `deploy/server/docker-compose.yml` - run Kinvest on the external `web` network.
- Create: `deploy/server/nginx.conf` - preserve TLS/ACME and proxy the site to Kinvest.
- Create: `deploy/server/docker-compose.nginx.yml` - explicitly attach the existing Nginx to `web`.
- Create: `deploy/server/logrotate-nginx` - bound existing Nginx log growth.
- Create: `server/tests/deploy-contract.test.js` - verify deployment files preserve security constraints.

**Deployment automation**

- Create: `deploy/server/deploy-kinvest.sh` - exact-commit deployment and rollback script.
- Create: `deploy/server/bootstrap-server.sh` - one-time directories, network, backup, and deploy-user setup.
- Create: `.github/workflows/deploy.yml` - verify then deploy `main`.
- Create: `server/tests/workflow-contract.test.js` - verify pinned host checking and secret handling.

**Operations**

- Create: `docs/deployment/server-runbook.md` - setup, deployment, rollback, token policy, and incident recovery.
- Modify: `README.md` - expose production URL and Mock deployment status.
- Create: `docs/screenshots/deployment/desktop.png` - production desktop evidence.
- Create: `docs/screenshots/deployment/mobile.png` - production mobile evidence.

---

### Task 1: Add a deterministic health contract

**Files:**

- Create: `server/tests/health.test.js`
- Create: `server/services/health.js`
- Modify: `server/tests/run-tests.js`
- Modify: `server/server.js`

- [ ] **Step 1: Write the failing health service test**

Create `server/tests/health.test.js`:

```javascript
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { getHealthState } = require('../services/health')

function run() {
  const dbFile = path.join('/tmp', `kinvest-health-${Date.now()}.sqlite`)
  setDbPath(dbFile)

  const now = new Date('2026-07-28T10:00:00.000Z')
  const state = getHealthState(now)

  assert.deepStrictEqual(state, {
    status: 'ok',
    service: 'kinvest',
    dataMode: 'mock',
    database: 'ready',
    timestamp: '2026-07-28T10:00:00.000Z'
  })
  assert.strictEqual(fs.existsSync(dbFile), true)

  resetDbForTests(dbFile)
}

module.exports = { run }
```

Append the module to `server/tests/run-tests.js`:

```javascript
const tests = [
  require('./refresh-policy.test'),
  require('./refresh-rules.test'),
  require('./health.test')
]
```

- [ ] **Step 2: Run the test and confirm the expected red state**

Run:

```bash
npm test
```

Expected: FAIL because `../services/health` does not exist.

- [ ] **Step 3: Implement the health service**

Create `server/services/health.js`:

```javascript
const { openDb } = require('../db/refresh-db')

function getHealthState(now = new Date()) {
  const result = openDb().prepare('SELECT 1 AS ready').get()
  if (!result || Number(result.ready) !== 1) {
    throw new Error('SQLite health query failed')
  }

  return {
    status: 'ok',
    service: 'kinvest',
    dataMode: 'mock',
    database: 'ready',
    timestamp: now.toISOString()
  }
}

module.exports = { getHealthState }
```

- [ ] **Step 4: Register `GET /api/health` before dynamic API routes**

Add the import to `server/server.js`:

```javascript
const { getHealthState } = require('./services/health')
```

Add this branch immediately after the `segments[0] !== 'api'` guard:

```javascript
if (segments[1] === 'health' && req.method === 'GET') {
  formatJson(res, getHealthState())
  return true
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test
```

Expected: three test modules pass and output `All tests passed`.

Commit:

```bash
git add server/server.js server/services/health.js server/tests/health.test.js server/tests/run-tests.js
git commit -m "feat: add deployment health endpoint"
git push origin main
```

---

### Task 2: Add lint, typecheck, and deterministic build

**Files:**

- Modify: `package.json`
- Create: `package-lock.json`
- Create: `eslint.config.js`
- Create: `jsconfig.json`
- Create: `scripts/build.js`
- Create: `server/tests/build.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Add the failing build contract**

Create `server/tests/build.test.js`:

```javascript
const fs = require('fs')
const path = require('path')
const assert = require('assert')

function run() {
  const root = path.join(__dirname, '..', '..')
  const required = [
    'dist/server/server.js',
    'dist/server/services/health.js',
    'dist/public/index.html',
    'dist/public/research.html',
    'dist/public/app.css',
    'dist/public/app.js'
  ]

  for (const relativePath of required) {
    assert.strictEqual(
      fs.existsSync(path.join(root, relativePath)),
      true,
      `${relativePath} must exist after npm run build`
    )
  }
}

module.exports = { run }
```

Add `require('./build.test')` as the final module in `server/tests/run-tests.js`.

- [ ] **Step 2: Add quality tooling and scripts**

Replace the `scripts` section in `package.json` with:

```json
{
  "dev": "node server/server.js",
  "start": "node server/server.js",
  "test": "node server/tests/run-tests.js",
  "lint": "eslint server scripts public/app.js",
  "typecheck": "tsc -p jsconfig.json",
  "build": "node scripts/build.js",
  "check": "npm run build && npm test && npm run lint && npm run typecheck"
}
```

Add:

```json
{
  "engines": {
    "node": ">=22"
  },
  "devDependencies": {
    "@eslint/js": "9.32.0",
    "@types/node": "24.1.0",
    "eslint": "9.32.0",
    "globals": "16.3.0",
    "typescript": "5.8.3"
  }
}
```

Run:

```bash
npm install
```

Expected: `package-lock.json` is created without runtime dependencies.

- [ ] **Step 3: Add ESLint and checkJs configuration**

Create `eslint.config.js`:

```javascript
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'docs/**']
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.browser
    }
  }
]
```

Create `jsconfig.json`:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "skipLibCheck": true,
    "strict": false
  },
  "include": [
    "server/**/*.js",
    "scripts/**/*.js"
  ],
  "exclude": [
    "dist",
    "node_modules"
  ]
}
```

- [ ] **Step 4: Implement deterministic build output**

Create `scripts/build.js`:

```javascript
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })

for (const directory of ['server', 'public']) {
  fs.cpSync(path.join(root, directory), path.join(dist, directory), {
    recursive: true,
    filter(source) {
      return !source.endsWith('.sqlite') && !source.endsWith('.sqlite-journal')
    }
  })
}

fs.rmSync(path.join(dist, 'server', 'tests'), { recursive: true, force: true })

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const runtimePackage = {
  name: packageJson.name,
  version: packageJson.version,
  private: true,
  type: packageJson.type,
  engines: packageJson.engines,
  scripts: {
    start: 'node server/server.js'
  }
}

fs.writeFileSync(
  path.join(dist, 'package.json'),
  `${JSON.stringify(runtimePackage, null, 2)}\n`
)
```

- [ ] **Step 5: Run the complete quality gate and fix only reported defects**

Run:

```bash
npm run check
```

Expected: build, all tests, ESLint, and TypeScript checkJs exit zero.

- [ ] **Step 6: Commit and push**

```bash
git add package.json package-lock.json eslint.config.js jsconfig.json scripts/build.js server/tests/build.test.js server/tests/run-tests.js
git commit -m "build: add Kinvest quality gates"
git push origin main
```

---

### Task 3: Containerize Kinvest without public app ports

**Files:**

- Create: `.dockerignore`
- Create: `Dockerfile`
- Create: `deploy/server/docker-compose.yml`
- Create: `server/tests/deploy-contract.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Write the failing container contract**

Create `server/tests/deploy-contract.test.js`:

```javascript
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.join(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function run() {
  const dockerfile = read('Dockerfile')
  const compose = read('deploy/server/docker-compose.yml')
  const dockerignore = read('.dockerignore')

  assert.match(dockerfile, /FROM node:22-alpine/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /HEALTHCHECK/)
  assert.match(compose, /external: true/)
  assert.match(compose, /KINVEST_DB_PATH: \/data\/kinvest\.sqlite/)
  assert.doesNotMatch(compose, /ports:/)
  assert.match(dockerignore, /\.env/)
  assert.match(dockerignore, /\*\.sqlite/)
  assert.match(dockerignore, /\*\.log/)
}

module.exports = { run }
```

Add `require('./deploy-contract.test')` to `server/tests/run-tests.js`.

- [ ] **Step 2: Add `.dockerignore`**

Create `.dockerignore`:

```text
.git
.github
.DS_Store
.env
.env.*
node_modules
dist
coverage
tmp
docs
*.log
*.sqlite
*.sqlite-journal
```

- [ ] **Step 3: Add the multi-stage Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY server ./server
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=4173
ENV KINVEST_DB_PATH=/data/kinvest.sqlite

WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./

USER node
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD wget -qO- http://127.0.0.1:4173/api/health >/dev/null || exit 1

CMD ["node", "server/server.js"]
```

- [ ] **Step 4: Add the app-only server Compose file**

Create `deploy/server/docker-compose.yml`:

```yaml
services:
  kinvest:
    image: ${KINVEST_IMAGE:-kinvest:local}
    container_name: kinvest
    restart: unless-stopped
    environment:
      TZ: Asia/Shanghai
      PORT: 4173
      KINVEST_DB_PATH: /data/kinvest.sqlite
    volumes:
      - /root/docker/kinvest/data:/data
    expose:
      - "4173"
    networks:
      - web
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4173/api/health"]
      interval: 15s
      timeout: 5s
      retries: 4
      start_period: 10s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

networks:
  web:
    external: true
```

- [ ] **Step 5: Run contract, quality, and local image checks**

Run:

```bash
npm run check
docker build -t kinvest:plan-check .
docker run --rm -d --name kinvest-plan-check -p 127.0.0.1:14173:4173 \
  -e KINVEST_DB_PATH=/tmp/kinvest.sqlite kinvest:plan-check
curl -fsS http://127.0.0.1:14173/api/health
docker stop kinvest-plan-check
```

Expected: health JSON contains `"status": "ok"` and `"dataMode": "mock"`.

- [ ] **Step 6: Commit and push**

```bash
git add .dockerignore Dockerfile deploy/server/docker-compose.yml server/tests/deploy-contract.test.js server/tests/run-tests.js
git commit -m "build: containerize Kinvest preview"
git push origin main
```

---

### Task 4: Define the Nginx cutover contract

**Files:**

- Create: `deploy/server/nginx.conf`
- Create: `deploy/server/docker-compose.nginx.yml`
- Create: `deploy/server/logrotate-nginx`
- Modify: `server/tests/deploy-contract.test.js`

- [ ] **Step 1: Extend the failing deployment contract**

Add these assertions to `server/tests/deploy-contract.test.js`:

```javascript
const nginx = read('deploy/server/nginx.conf')
const override = read('deploy/server/docker-compose.nginx.yml')
const logrotate = read('deploy/server/logrotate-nginx')

assert.match(nginx, /ssl_certificate \/etc\/letsencrypt\/live\/dearmina\.cn\/fullchain\.pem/)
assert.match(nginx, /location \/.well-known\/acme-challenge\//)
assert.match(nginx, /resolver 127\.0\.0\.11 valid=10s ipv6=off/)
assert.match(nginx, /proxy_pass \$kinvest_upstream/)
assert.match(nginx, /client_max_body_size 1m/)
assert.match(nginx, /X-Content-Type-Options/)
assert.match(nginx, /limit_req_zone/)
assert.match(override, /external: true/)
assert.match(override, /- web/)
assert.match(logrotate, /rotate 14/)
assert.match(logrotate, /copytruncate/)
```

Run `npm test`.

Expected: FAIL because the Nginx and override files do not exist.

- [ ] **Step 2: Add the existing-stack network override**

Create `deploy/server/docker-compose.nginx.yml`. This filename is intentionally
not auto-loaded: every server command must explicitly merge it with the
server's existing Compose file using two `-f` arguments.

```yaml
services:
  nginx:
    networks:
      - default
      - web

networks:
  web:
    external: true
```

- [ ] **Step 3: Add the complete Nginx configuration**

Create `deploy/server/nginx.conf`:

```nginx
events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  server_tokens off;

  map $uri $kinvest_cache_control {
    default "no-store";
    ~^/assets/ "public, max-age=31536000, immutable";
    ~*\.(?:css|js|svg|png|jpg|jpeg|webp|ico)$ "public, max-age=3600";
  }

  map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
  }

  limit_req_zone $binary_remote_addr zone=kinvest_api:10m rate=10r/s;
  limit_req_zone $binary_remote_addr zone=kinvest_refresh:10m rate=2r/m;
  limit_req_status 429;
  resolver 127.0.0.11 valid=10s ipv6=off;

  server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
  }

  server {
    listen 80;
    listen [::]:80;
    server_name dearmina.cn www.dearmina.cn;

    location /.well-known/acme-challenge/ {
      root /var/www/certbot;
      try_files $uri =404;
    }

    location / {
      return 301 https://dearmina.cn$request_uri;
    }
  }

  server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;

    ssl_certificate /etc/letsencrypt/live/dearmina.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dearmina.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    return 444;
  }

  server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name dearmina.cn www.dearmina.cn;

    ssl_certificate /etc/letsencrypt/live/dearmina.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dearmina.cn/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 5m;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;
    ssl_prefer_server_ciphers on;

    client_max_body_size 1m;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header Cache-Control $kinvest_cache_control always;

    set $kinvest_upstream http://kinvest:4173;

    location ~ ^/api/company/[^/]+/refresh$ {
      limit_req zone=kinvest_refresh burst=2 nodelay;
      proxy_pass $kinvest_upstream;
      proxy_http_version 1.1;
      proxy_set_header Host dearmina.cn;
      proxy_set_header X-Forwarded-Host dearmina.cn;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
    }

    location /api/ {
      limit_req zone=kinvest_api burst=20 nodelay;
      proxy_pass $kinvest_upstream;
      proxy_http_version 1.1;
      proxy_set_header Host dearmina.cn;
      proxy_set_header X-Forwarded-Host dearmina.cn;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
    }

    location /assets/ {
      proxy_pass $kinvest_upstream;
      proxy_http_version 1.1;
      proxy_set_header Host dearmina.cn;
      proxy_set_header X-Forwarded-Host dearmina.cn;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
    }

    location / {
      proxy_pass $kinvest_upstream;
      proxy_http_version 1.1;
      proxy_set_header Host dearmina.cn;
      proxy_set_header X-Forwarded-Host dearmina.cn;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_connect_timeout 5s;
      proxy_read_timeout 30s;
    }
  }
}
```

- [ ] **Step 4: Add bounded Nginx log rotation**

Create `deploy/server/logrotate-nginx`:

```text
/root/docker/nginx/log/*.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
```

- [ ] **Step 5: Validate Nginx syntax in a disposable container**

Run:

```bash
docker run --rm \
  -v "$PWD/deploy/server/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$CERT_DIR:/etc/letsencrypt/live/dearmina.cn:ro" \
  nginx:1.27.5-alpine nginx -t
```

Expected: `syntax is ok` and `test is successful` even when the Kinvest container
is absent, because Docker DNS resolution occurs per request. Also merge
`deploy/server/docker-compose.nginx.yml` explicitly with a minimal fixture for
the existing Nginx service using `docker compose -f <fixture> -f
deploy/server/docker-compose.nginx.yml config`; verify the merged service retains
its fixture image, ports, and volumes and adds both `default` and `web` networks.

- [ ] **Step 6: Run the full quality gate, commit, and push**

```bash
npm run check
git add deploy/server/nginx.conf deploy/server/docker-compose.nginx.yml deploy/server/logrotate-nginx server/tests/deploy-contract.test.js
git commit -m "ops: define Kinvest nginx cutover"
git push origin main
```

---

### Task 5: Add exact-commit deployment and workflow contracts

**Files:**

- Create: `deploy/server/deploy-kinvest.sh`
- Create: `deploy/server/bootstrap-server.sh`
- Create: `.github/workflows/deploy.yml`
- Create: `server/tests/workflow-contract.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Write the failing workflow contract**

Create `server/tests/workflow-contract.test.js`:

```javascript
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.join(__dirname, '..', '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function run() {
  const workflow = read('.github/workflows/deploy.yml')
  const deploy = read('deploy/server/deploy-kinvest.sh')
  const bootstrap = read('deploy/server/bootstrap-server.sh')

  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /npm run check/)
  assert.match(workflow, /DEPLOY_KNOWN_HOSTS/)
  assert.match(workflow, /DEPLOY_ENABLED == 'true'/)
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/)
  assert.match(workflow, /sudo \/usr\/local\/sbin\/deploy-kinvest/)

  assert.match(deploy, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(deploy, /docker inspect/)
  assert.match(deploy, /previous\.env/)
  assert.match(deploy, /curl -fsS https:\/\/dearmina\.cn\/api\/health/)

  assert.match(bootstrap, /kinvest-deploy/)
  assert.match(bootstrap, /chmod 700/)
  assert.match(bootstrap, /docker network create web/)
  assert.doesNotMatch(bootstrap, /PasswordAuthentication yes/)
}

module.exports = { run }
```

Add `require('./workflow-contract.test')` to `server/tests/run-tests.js`.

- [ ] **Step 2: Implement the root-owned deployment script**

Create `deploy/server/deploy-kinvest.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "deployment requires a 40-character commit SHA" >&2
  exit 2
fi

smoke_mode="${2:-required}"
if [[ "$smoke_mode" != "required" && "$smoke_mode" != "skip-public" ]]; then
  echo "smoke mode must be required or skip-public" >&2
  exit 2
fi

repo="/opt/kinvest/repository"
releases="/opt/kinvest/releases"
release="$releases/$sha"
state="/etc/kinvest"
compose="$state/docker-compose.yml"
current="$state/current.env"
previous="$state/previous.env"
image="kinvest:$sha"

mkdir -p "$releases"
git -C "$repo" fetch --prune origin main
git -C "$repo" cat-file -e "$sha^{commit}"

if [[ ! -d "$release" ]]; then
  git -C "$repo" worktree add --detach "$release" "$sha"
fi

docker build --pull --tag "$image" "$release"

if [[ -f "$current" ]]; then
  cp "$current" "$previous"
fi

tmp_env="$(mktemp "$state/current.env.XXXXXX")"
printf 'KINVEST_IMAGE=%s\n' "$image" > "$tmp_env"
chmod 600 "$tmp_env"
mv "$tmp_env" "$current"

rollback() {
  if [[ -f "$previous" ]]; then
    cp "$previous" "$current"
    docker compose --env-file "$current" -f "$compose" up -d
  else
    rm -f "$current"
    docker rm -f kinvest >/dev/null 2>&1 || true
  fi
}
trap rollback ERR

docker compose --env-file "$current" -f "$compose" up -d

for attempt in $(seq 1 20); do
  status="$(docker inspect --format '{{.State.Health.Status}}' kinvest 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  if [[ "$attempt" == "20" ]]; then
    echo "Kinvest container did not become healthy" >&2
    exit 1
  fi
  sleep 3
done

if [[ "$smoke_mode" == "required" ]]; then
  curl -fsS https://dearmina.cn/api/health >/dev/null
fi
trap - ERR
logger -t kinvest-deploy "deployed commit $sha"

git -C "$repo" worktree prune
```

- [ ] **Step 3: Implement the one-time bootstrap script**

Create `deploy/server/bootstrap-server.sh` with:

```bash
#!/usr/bin/env bash
set -euo pipefail

public_key_file="${1:?public key file is required}"
repo_url="https://github.com/zwphhxx/Kinvest.git"
backup="/root/backups/kinvest-cutover-$(date -u +%Y%m%dT%H%M%SZ)"

for command in git docker curl visudo; do
  command -v "$command" >/dev/null
done

install -d -m 755 /etc/kinvest
install -d -m 700 "$backup"
cp /root/docker/nginx/conf/nginx.conf "$backup/nginx.conf"
cp /root/docker/docker-compose.yml "$backup/docker-compose.yml"
cp -a /root/docker/nginx/html "$backup/html"
docker ps --format '{{.Image}} {{.Names}} {{.Status}}' > "$backup/containers.txt"
printf '%s\n' "$backup" > /etc/kinvest/backup_path
chmod 600 /etc/kinvest/backup_path

id kinvest-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash kinvest-deploy
passwd -l kinvest-deploy
install -d -o kinvest-deploy -g kinvest-deploy -m 700 /home/kinvest-deploy/.ssh
install -o kinvest-deploy -g kinvest-deploy -m 600 "$public_key_file" /home/kinvest-deploy/.ssh/authorized_keys

install -d -m 755 /opt/kinvest /opt/kinvest/releases
if [[ ! -d /opt/kinvest/repository/.git ]]; then
  git clone "$repo_url" /opt/kinvest/repository
fi

install -d -o 1000 -g 1000 -m 700 /root/docker/kinvest/data

docker network inspect web >/dev/null 2>&1 || docker network create web

printf '%s\n' 'kinvest-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest *' \
  > /etc/sudoers.d/kinvest-deploy
chmod 440 /etc/sudoers.d/kinvest-deploy
visudo -cf /etc/sudoers.d/kinvest-deploy

echo "$backup"
```

- [ ] **Step 4: Add the GitHub Actions workflow**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Kinvest

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: kinvest-production
  cancel-in-progress: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: docker build -t kinvest:${{ github.sha }} .

  deploy:
    needs: verify
    if: vars.DEPLOY_ENABLED == 'true'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Configure pinned SSH host and deploy key
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
          DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          install -d -m 700 ~/.ssh
          printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 600 ~/.ssh/known_hosts
      - name: Deploy exact commit
        env:
          DEPLOY_HOST: ${{ vars.DEPLOY_HOST }}
          DEPLOY_PORT: ${{ vars.DEPLOY_PORT }}
          DEPLOY_USER: ${{ vars.DEPLOY_USER }}
          DEPLOY_SHA: ${{ github.sha }}
        run: |
          ssh -p "$DEPLOY_PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
            "sudo /usr/local/sbin/deploy-kinvest '$DEPLOY_SHA'"
```

- [ ] **Step 5: Validate scripts and workflow contracts**

Run:

```bash
bash -n deploy/server/deploy-kinvest.sh
bash -n deploy/server/bootstrap-server.sh
npm run check
```

Expected: Bash syntax and all project checks pass.

- [ ] **Step 6: Disable automatic deployment until server bootstrap completes**

Run:

```bash
gh variable set DEPLOY_ENABLED --body 'false'
```

Expected: repository variable `DEPLOY_ENABLED` is set without creating a secret.

- [ ] **Step 7: Commit and push**

```bash
git add deploy/server/deploy-kinvest.sh deploy/server/bootstrap-server.sh .github/workflows/deploy.yml server/tests/workflow-contract.test.js server/tests/run-tests.js
git commit -m "ci: add controlled server deployment"
git push origin main
```

---

### Task 6: Validate the preview locally in desktop and mobile views

**Files:**

- Create: `docs/screenshots/deployment/local-desktop.png`
- Create: `docs/screenshots/deployment/local-mobile.png`

- [ ] **Step 1: Start the container locally**

Run:

```bash
docker build -t kinvest:local-preview .
docker run --rm -d --name kinvest-local-preview \
  -p 127.0.0.1:14173:4173 \
  -e KINVEST_DB_PATH=/tmp/kinvest.sqlite \
  kinvest:local-preview
```

- [ ] **Step 2: Verify application behavior**

Check:

```bash
curl -fsS http://127.0.0.1:14173/api/health
curl -fsS http://127.0.0.1:14173/api/watchlist
curl -fsS "http://127.0.0.1:14173/api/company/09888.HK"
curl -fsS "http://127.0.0.1:14173/api/research/09888.HK"
```

Expected: every request succeeds; health and company data report Mock mode.

- [ ] **Step 3: Perform browser validation**

Use a desktop viewport of 1440x900 and a mobile viewport of 390x844. Verify:

- homepage watchlist and search render without horizontal scrolling
- company quote, valuation, financial segments, anomaly signals, announcements, and news are visible
- refresh source time, cache state, market state, next refresh, cooldown, and quota are visible
- default page does not show AI investment conclusions
- research page carries AI/Mock labels

Save screenshots to:

```text
docs/screenshots/deployment/local-desktop.png
docs/screenshots/deployment/local-mobile.png
```

- [ ] **Step 4: Stop the local preview**

```bash
docker stop kinvest-local-preview
```

- [ ] **Step 5: Commit visual evidence**

```bash
git add docs/screenshots/deployment/local-desktop.png docs/screenshots/deployment/local-mobile.png
git commit -m "docs: record local deployment preview"
git push origin main
```

---

### Task 7: Bootstrap the server with a recoverable backup

**Files installed on server:**

- `/usr/local/sbin/deploy-kinvest`
- `/etc/kinvest/docker-compose.yml`
- `/etc/kinvest/docker-compose.nginx.yml`
- `/home/kinvest-deploy/.ssh/authorized_keys`
- `/etc/sudoers.d/kinvest-deploy`

- [ ] **Step 1: Generate a dedicated temporary deployment key**

Run locally:

```bash
install -d -m 700 /private/tmp/kinvest-deploy-key
ssh-keygen -t ed25519 -N '' \
  -C 'kinvest-github-actions' \
  -f /private/tmp/kinvest-deploy-key/id_ed25519
```

Expected: private key mode 600 and public key mode 644.

- [ ] **Step 2: Copy only bootstrap inputs to a temporary server directory**

```bash
ssh -p 4334 root@106.54.229.241 'install -d -m 700 /root/kinvest-bootstrap'
scp -P 4334 \
  deploy/server/bootstrap-server.sh \
  deploy/server/deploy-kinvest.sh \
  deploy/server/docker-compose.yml \
  deploy/server/docker-compose.nginx.yml \
  deploy/server/nginx.conf \
  deploy/server/logrotate-nginx \
  /private/tmp/kinvest-deploy-key/id_ed25519.pub \
  root@106.54.229.241:/root/kinvest-bootstrap/
```

- [ ] **Step 3: Run bootstrap and capture the backup path**

Run:

```bash
ssh -p 4334 root@106.54.229.241 \
  'bash /root/kinvest-bootstrap/bootstrap-server.sh /root/kinvest-bootstrap/id_ed25519.pub'
```

Expected: a timestamped path such as
`/root/backups/kinvest-cutover-20260728T102500Z`.

- [ ] **Step 4: Install reviewed root-owned files**

Run through root SSH:

```bash
install -o root -g root -m 755 \
  /root/kinvest-bootstrap/deploy-kinvest.sh \
  /usr/local/sbin/deploy-kinvest
install -o root -g root -m 644 \
  /root/kinvest-bootstrap/docker-compose.yml \
  /etc/kinvest/docker-compose.yml
install -o root -g root -m 644 \
  /root/kinvest-bootstrap/docker-compose.nginx.yml \
  /etc/kinvest/docker-compose.nginx.yml
install -o root -g root -m 600 \
  /root/kinvest-bootstrap/nginx.conf \
  /etc/kinvest/nginx.conf
install -o root -g root -m 644 \
  /root/kinvest-bootstrap/logrotate-nginx \
  /etc/logrotate.d/kinvest-nginx
```

- [ ] **Step 5: Verify backup and deployment-user boundaries**

Run:

```bash
test -d /root/backups
test -f /usr/local/sbin/deploy-kinvest
test -f /etc/kinvest/docker-compose.yml
visudo -cf /etc/sudoers.d/kinvest-deploy
sudo -u kinvest-deploy ssh-keygen -lf /home/kinvest-deploy/.ssh/authorized_keys
docker network inspect web
```

Expected: all commands succeed and no secret value is printed.

---

### Task 8: Perform the first container deployment and atomic Nginx cutover

**Server files modified:**

- `/root/docker/nginx/conf/nginx.conf`
- `/etc/kinvest/docker-compose.nginx.yml`
- `/etc/kinvest/current.env`

- [ ] **Step 1: Deploy the exact GitHub commit before switching Nginx**

Resolve the current commit locally and pass it to the explicit first-cutover mode:

```bash
DEPLOY_SHA="$(git rev-parse HEAD)"
ssh -i /Users/zhuwenpeng/.ssh/id_ed25519 \
  -p 4334 \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/private/tmp/kinvest_known_hosts \
  root@106.54.229.241 \
  "/usr/local/sbin/deploy-kinvest '$DEPLOY_SHA' skip-public"
```

Expected: the container becomes healthy without requiring the old Nginx route to
return the new health endpoint. Later deployments use the default `required` mode.

- [ ] **Step 2: Attach existing Nginx to the private web network**

Run:

```bash
docker compose \
  -f /root/docker/docker-compose.yml \
  -f /etc/kinvest/docker-compose.nginx.yml \
  up -d nginx
docker network inspect web
```

Expected: both `nginx` and `kinvest` appear on network `web`.

- [ ] **Step 3: Validate the new Nginx config before replacement**

Run:

```bash
docker exec nginx nginx -t
docker run --rm --network web \
  -v /etc/kinvest/nginx.conf:/etc/nginx/nginx.conf:ro \
  -v /root/docker/certbot/ssl:/etc/letsencrypt:ro \
  nginx:1.27.5-alpine nginx -t
```

Expected: both syntax checks succeed.

- [ ] **Step 4: Atomically switch the Nginx configuration**

Run:

```bash
install -o root -g root -m 644 \
  /etc/kinvest/nginx.conf \
  /root/docker/nginx/conf/nginx.conf.next
mv /root/docker/nginx/conf/nginx.conf.next /root/docker/nginx/conf/nginx.conf
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

- [ ] **Step 5: Verify public HTTPS and security behavior**

Run:

```bash
curl -fsS https://dearmina.cn/api/health
curl -fsS https://www.dearmina.cn/api/watchlist
curl -fsSI http://dearmina.cn/
curl -fsSI https://dearmina.cn/
```

Expected:

- health reports `ok`, `mock`, and `ready`
- HTTP redirects to HTTPS
- HTTPS returns security headers
- homepage and API return successful status

- [ ] **Step 6: Verify no application or database port is public**

From the local machine:

```bash
nc -vz -w 5 106.54.229.241 4173
nc -vz -w 5 106.54.229.241 3306
```

Expected: both connections fail.

---

### Task 9: Configure GitHub Production Environment and prove automatic deployment

**External state:**

- GitHub environment: `production`
- Environment variables: `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`
- Environment secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`

- [ ] **Step 1: Create or update GitHub environment values**

Run:

```bash
gh variable set DEPLOY_HOST --env production --body '106.54.229.241'
gh variable set DEPLOY_PORT --env production --body '4334'
gh variable set DEPLOY_USER --env production --body 'kinvest-deploy'
gh secret set DEPLOY_SSH_KEY --env production \
  < /private/tmp/kinvest-deploy-key/id_ed25519
gh secret set DEPLOY_KNOWN_HOSTS --env production \
  < /private/tmp/kinvest_known_hosts
gh variable set DEPLOY_ENABLED --body 'true'
```

Expected: GitHub confirms creation without printing secret values.

- [ ] **Step 2: Test the deployment user directly**

```bash
ssh -i /private/tmp/kinvest-deploy-key/id_ed25519 \
  -p 4334 kinvest-deploy@106.54.229.241 \
  'sudo /usr/local/sbin/deploy-kinvest 0000000000000000000000000000000000000000'
```

Expected: the script rejects the unknown commit after accepting the argument
format; the user cannot run unrestricted passwordless sudo commands.

- [ ] **Step 3: Trigger and monitor a no-change deployment**

Use GitHub workflow dispatch for `.github/workflows/deploy.yml`, then verify:

- verify job passes `npm ci`, `npm run check`, and Docker build
- deploy job connects using the dedicated user
- server deploys the exact workflow SHA
- public health remains successful

- [ ] **Step 4: Remove the temporary local private key**

After GitHub Actions succeeds:

```bash
find /private/tmp/kinvest-deploy-key -type f -exec chmod 600 {} \;
rm -rf /private/tmp/kinvest-deploy-key
```

Expected: the temporary private key no longer exists locally. The server public
key and GitHub encrypted secret remain sufficient; rotation creates a new pair.

---

### Task 10: Validate production visually and exercise rollback

**Files:**

- Create: `docs/screenshots/deployment/desktop.png`
- Create: `docs/screenshots/deployment/mobile.png`

- [ ] **Step 1: Capture desktop production evidence**

Open `https://dearmina.cn` at 1440x900. Verify the same content boundaries from
Task 6 and save:

```text
docs/screenshots/deployment/desktop.png
```

- [ ] **Step 2: Capture mobile production evidence**

Open `https://dearmina.cn` at 390x844. Verify no horizontal overflow, readable
cards, accessible search, and working research navigation. Save:

```text
docs/screenshots/deployment/mobile.png
```

- [ ] **Step 3: Exercise a real, brief Nginx rollback and forward recovery**

Run on the server:

```bash
backup="$(cat /etc/kinvest/backup_path)"
cp /root/docker/nginx/conf/nginx.conf /etc/kinvest/nginx.current
cp "$backup/nginx.conf" /root/docker/nginx/conf/nginx.conf.rollback
mv /root/docker/nginx/conf/nginx.conf.rollback /root/docker/nginx/conf/nginx.conf
docker exec nginx nginx -t
docker exec nginx nginx -s reload
test "$(curl -fsS https://dearmina.cn/ | sha256sum | awk '{print $1}')" = \
  "$(sha256sum "$backup/html/index.html" | awk '{print $1}')"
cp /etc/kinvest/nginx.current /root/docker/nginx/conf/nginx.conf.forward
mv /root/docker/nginx/conf/nginx.conf.forward /root/docker/nginx/conf/nginx.conf
docker exec nginx nginx -t
docker exec nginx nginx -s reload
curl -fsS https://dearmina.cn/api/health
```

Expected: the old page checksum matches its backup during rollback, then Kinvest
health succeeds immediately after the forward recovery.

- [ ] **Step 4: Verify current production remains active**

```bash
docker exec nginx nginx -t
curl -fsS https://dearmina.cn/api/health
docker inspect --format '{{.State.Health.Status}}' kinvest
```

Expected: Nginx passes, public health succeeds, and container status is `healthy`.

---

### Task 11: Publish operations documentation and final evidence

**Files:**

- Create: `docs/deployment/server-runbook.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-28-kinvest-server-deployment.md`

- [ ] **Step 1: Write the server runbook**

Document exact commands for:

- checking GitHub workflow and deployed SHA
- checking container and Nginx health
- rolling back to `/etc/kinvest/previous.env`
- restoring the timestamped old-site backup
- rotating the GitHub deployment key
- manually updating future iFinD `refresh_token` through Tencent Cloud secrets
- confirming no token enters disk, web, database, logs, Git, or chat

The runbook must refer to secret names, never secret values.

- [ ] **Step 2: Update README deployment status**

Set the preview URL to `https://dearmina.cn`, clearly label all current data as
Mock, and describe that `main` deploys only after the complete quality gate.

- [ ] **Step 3: Mark completed plan checkboxes from real evidence**

Only mark a checkbox complete after its command has run and its expected result
has been observed. Leave blocked items unchecked with a short reason.

- [ ] **Step 4: Run final verification and sensitive scan**

Run:

```bash
npm run check
docker build -t kinvest:final-check .
git diff --check
git status --short
rg -l \
  'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKID[A-Za-z0-9]{16,}' \
  . --glob '!node_modules/**' --glob '!dist/**'
```

Expected:

- checks and image build pass
- diff check has no output
- secret-pattern scan has no output
- only intended documentation and screenshot files remain uncommitted

- [ ] **Step 5: Commit and push final evidence**

```bash
git add README.md docs/deployment/server-runbook.md docs/screenshots/deployment docs/superpowers/plans/2026-07-28-kinvest-server-deployment.md
git commit -m "docs: complete Kinvest preview deployment"
git push origin main
```

- [ ] **Step 6: Verify GitHub and public production one final time**

Confirm:

```bash
git ls-remote origin refs/heads/main
curl -fsS https://dearmina.cn/api/health
curl -fsSI https://dearmina.cn/
```

Expected: remote `main` matches the local final commit, health reports Mock mode,
and the site returns HTTPS with the designed security headers.
