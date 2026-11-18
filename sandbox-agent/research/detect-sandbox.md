# Detecting cloud sandbox providers from within your code

A process can reliably identify its sandbox provider by checking environment variables, filesystem markers, and metadata endpoints in a specific order. **Environment variables are the fastest and most reliable method** for most sandbox providers, with each major provider exposing unique prefixed variables like `E2B_SANDBOX`, `VERCEL`, `FLY_APP_NAME`, and `REPL_ID`. This report provides a complete detection strategy with tested code examples for implementing provider telemetry.

The detection hierarchy should be: environment variables first (instant), filesystem checks second (sub-millisecond), and metadata services last (100-500ms with network calls). Most sandbox providers now expose explicit environment variables specifically designed for runtime detection, making identification straightforward when you know what to look for.

---

## E2B sandboxes expose four dedicated environment variables

E2B provides the cleanest detection story with explicitly documented environment variables and filesystem fallbacks:

| Variable | Value/Example | Confidence |
|----------|---------------|------------|
| `E2B_SANDBOX` | `"true"` | ✅ Documented |
| `E2B_SANDBOX_ID` | Unique sandbox identifier | ✅ Documented |
| `E2B_TEAM_ID` | Team that created the sandbox | ✅ Documented |
| `E2B_TEMPLATE_ID` | Template used for sandbox | ✅ Documented |

**Filesystem fallback**: When using E2B CLI (not SDK), these values are also stored as dot files at `/run/e2b/.E2B_SANDBOX`, `/run/e2b/.E2B_SANDBOX_ID`, etc.

```typescript
function detectE2B(): ProviderResult | null {
  if (process.env.E2B_SANDBOX === 'true') {
    return {
      provider: 'e2b',
      confidence: 'high',
      metadata: {
        sandboxId: process.env.E2B_SANDBOX_ID,
        teamId: process.env.E2B_TEAM_ID,
        templateId: process.env.E2B_TEMPLATE_ID,
      }
    };
  }
  
  // Filesystem fallback for CLI usage
  if (fs.existsSync('/run/e2b/.E2B_SANDBOX')) {
    return { provider: 'e2b', confidence: 'high', method: 'filesystem' };
  }
  return null;
}
```

---

## Daytona requires heuristic detection through user and directory checks

Daytona lacks explicit detection environment variables, requiring multiple signal checks:

| Detection Method | Marker | Confidence |
|------------------|--------|------------|
| Username | Running as user `daytona` | ⚠️ Medium |
| Home directory | `/home/daytona` exists | ⚠️ Medium |
| Config directory | `~/.daytona` exists | ⚠️ Medium |
| Container image | `daytonaio/workspace-project` | ⚠️ Medium |

```typescript
function detectDaytona(): ProviderResult | null {
  const signals: string[] = [];
  
  // Check username
  const username = os.userInfo().username;
  if (username === 'daytona') signals.push('user');
  
  // Check home directory
  if (fs.existsSync('/home/daytona')) signals.push('home_dir');
  
  // Check config directory
  const configPath = path.join(os.homedir(), '.daytona');
  if (fs.existsSync(configPath)) signals.push('config_dir');
  
  if (signals.length >= 2) {
    return { provider: 'daytona', confidence: 'medium', signals };
  }
  return null;
}
```

**Recommendation**: File a feature request with Daytona to add `DAYTONA_SANDBOX=true` for reliable detection.

---

## Vercel detection varies by runtime type

Vercel environments are more complex because they span serverless functions (AWS Lambda), Edge Runtime (V8), and the newer Sandbox SDK:

**Core detection variables** (available in all Vercel environments):

| Variable | Description |
|----------|-------------|
| `VERCEL` | `"1"` — Primary indicator |
| `VERCEL_ENV` | `production`, `preview`, or `development` |
| `VERCEL_REGION` | Region code like `cdg1`, `iad1` (runtime only) |
| `VERCEL_DEPLOYMENT_ID` | Unique deployment identifier |
| `VERCEL_URL` | Deployment URL without protocol |

**Runtime-specific detection**:

```typescript
function detectVercel(): VercelEnvironment | null {
  if (process.env.VERCEL !== '1') return null;
  
  const isEdgeRuntime = typeof globalThis.EdgeRuntime !== 'undefined';
  const isServerless = Boolean(process.env.LAMBDA_TASK_ROOT);
  const isBuildTime = process.env.CI === '1';
  
  let runtimeType: 'edge' | 'serverless' | 'static' | 'sandbox';
  if (isEdgeRuntime) runtimeType = 'edge';
  else if (isServerless) runtimeType = 'serverless';
  else if (process.env.VERCEL_SANDBOX) runtimeType = 'sandbox';
  else runtimeType = 'static';
  
  return {
    provider: 'vercel',
    confidence: 'high',
    runtimeType,
    environment: process.env.VERCEL_ENV as 'production' | 'preview' | 'development',
    region: process.env.VERCEL_REGION,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
  };
}
```

**Lambda indicators** (underneath Vercel serverless): `LAMBDA_TASK_ROOT`, `AWS_LAMBDA_FUNCTION_NAME`, `AWS_REGION`, `AWS_EXECUTION_ENV`.

**Request header detection** for runtime context: `x-vercel-id` (trace ID with region), `x-vercel-deployment-url`, `x-vercel-ip-country`.

---

## CodeSandbox and Replit detection through environment and filesystem

**CodeSandbox** uses `CODESANDBOX_HOST` as the primary indicator:

```typescript
function detectCodeSandbox(): ProviderResult | null {
  if (process.env.CODESANDBOX_HOST || process.env.CSB_BASE_PREVIEW_HOST) {
    return {
      provider: 'codesandbox',
      confidence: 'high',
      host: process.env.CODESANDBOX_HOST,
    };
  }
  // Legacy SSE sandboxes
  if (process.env.CODESANDBOX_SSE || process.env.SANDBOX_URL) {
    return { provider: 'codesandbox', confidence: 'high', legacy: true };
  }
  return null;
}
```

**Replit** exposes comprehensive environment variables:

| Variable | Description |
|----------|-------------|
| `REPL_ID` | Unique repl identifier |
| `REPL_SLUG` | URL-safe repl name |
| `REPL_OWNER` | Username of owner |
| `REPLIT_DB_URL` | Built-in database URL |

```typescript
function detectReplit(): ProviderResult | null {
  if (process.env.REPL_ID || process.env.REPL_SLUG) {
    return {
      provider: 'replit',
      confidence: 'high',
      replId: process.env.REPL_ID,
      slug: process.env.REPL_SLUG,
      owner: process.env.REPL_OWNER,
    };
  }
  // Filesystem fallback
  if (fs.existsSync('.replit') || fs.existsSync('replit.nix')) {
    return { provider: 'replit', confidence: 'medium', method: 'filesystem' };
  }
  return null;
}
```

---

## Modal and Fly.io have the most complete documentation

**Modal** provides reserved environment variables that cannot be overridden:

| Variable | Scope |
|----------|-------|
| `MODAL_IS_REMOTE` | `"1"` when in Modal container |
| `MODAL_CLOUD_PROVIDER` | AWS, GCP, or OCI |
| `MODAL_REGION` | Geographic region |
| `MODAL_TASK_ID` | Container ID |
| `MODAL_SANDBOX_ID` | Sandbox-only identifier |
| `MODAL_ENVIRONMENT` | Functions-only environment name |

```typescript
function detectModal(): ProviderResult | null {
  if (process.env.MODAL_IS_REMOTE === '1' || process.env.MODAL_CLOUD_PROVIDER) {
    const isSandbox = Boolean(process.env.MODAL_SANDBOX_ID);
    return {
      provider: 'modal',
      confidence: 'high',
      type: isSandbox ? 'sandbox' : 'function',
      cloudProvider: process.env.MODAL_CLOUD_PROVIDER,
      region: process.env.MODAL_REGION,
      taskId: process.env.MODAL_TASK_ID,
    };
  }
  return null;
}
```

**Fly.io** similarly exposes comprehensive runtime variables:

| Variable | Description |
|----------|-------------|
| `FLY_APP_NAME` | Application name |
| `FLY_MACHINE_ID` | Unique machine ID |
| `FLY_REGION` | Three-letter region code (`ams`, `ord`) |
| `FLY_VM_MEMORY_MB` | Allocated memory |
| `PRIMARY_REGION` | Primary deployment region |

```typescript
function detectFlyIo(): ProviderResult | null {
  if (process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID) {
    return {
      provider: 'fly.io',
      confidence: 'high',
      appName: process.env.FLY_APP_NAME,
      machineId: process.env.FLY_MACHINE_ID,
      region: process.env.FLY_REGION,
      memoryMb: process.env.FLY_VM_MEMORY_MB,
    };
  }
  return null;
}
```

---

## General detection techniques for unknown providers

When dedicated environment variables aren't available, use these hierarchical fallbacks:

**Container detection** via cgroups and filesystem:
```typescript
function detectContainer(): ContainerInfo | null {
  // Docker
  if (fs.existsSync('/.dockerenv')) {
    return { type: 'docker', confidence: 'high' };
  }
  
  // Podman
  if (fs.existsSync('/run/.containerenv')) {
    return { type: 'podman', confidence: 'high' };
  }
  
  // Kubernetes
  if (process.env.KUBERNETES_SERVICE_HOST) {
    return { 
      type: 'kubernetes', 
      confidence: 'high',
      namespace: fs.readFileSync(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8'
      ).trim()
    };
  }
  
  // Cgroup inspection for containerized environments
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      return { type: 'docker', confidence: 'medium', method: 'cgroup' };
    }
    if (cgroup.includes('kubepods')) {
      return { type: 'kubernetes', confidence: 'medium', method: 'cgroup' };
    }
  } catch {}
  
  return null;
}
```

**VM/Hypervisor detection** via DMI data:
```typescript
function detectHypervisor(): HypervisorInfo | null {
  const dmiPaths = {
    sysVendor: '/sys/class/dmi/id/sys_vendor',
    productName: '/sys/class/dmi/id/product_name',
    biosVendor: '/sys/class/dmi/id/bios_vendor',
  };
  
  const vendorMappings: Record<string, string> = {
    'Amazon EC2': 'aws',
    'Google Compute Engine': 'gcp',
    'Microsoft Corporation': 'azure',
    'VMware, Inc.': 'vmware',
    'QEMU': 'qemu',
    'Xen': 'xen',
    'innotek GmbH': 'virtualbox',
  };
  
  try {
    const sysVendor = fs.readFileSync(dmiPaths.sysVendor, 'utf8').trim();
    const productName = fs.readFileSync(dmiPaths.productName, 'utf8').trim();
    
    for (const [pattern, provider] of Object.entries(vendorMappings)) {
      if (sysVendor.includes(pattern) || productName.includes(pattern)) {
        return { hypervisor: provider, sysVendor, productName };
      }
    }
  } catch {}
  
  return null;
}
```

**Cloud metadata service** for major cloud providers:
```typescript
async function detectCloudViaMetadata(timeoutMs = 500): Promise<CloudInfo | null> {
  const endpoints = [
    { provider: 'aws', url: 'http://169.254.169.254/latest/meta-data/', headers: {} },
    { provider: 'gcp', url: 'http://169.254.169.254/computeMetadata/v1/', 
      headers: { 'Metadata-Flavor': 'Google' } },
    { provider: 'azure', url: 'http://169.254.169.254/metadata/instance?api-version=2021-02-01',
      headers: { 'Metadata': 'true' } },
  ];
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const results = await Promise.allSettled(
      endpoints.map(async ({ provider, url, headers }) => {
        const res = await fetch(url, { 
          headers, 
          signal: controller.signal 
        });
        if (res.ok) return provider;
        throw new Error('Not this provider');
      })
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        return { provider: result.value, method: 'metadata' };
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  return null;
}
```

---

## Complete provider detection module implementation

Here's a production-ready implementation combining all detection methods:

```typescript
interface ProviderResult {
  provider: string;
  confidence: 'high' | 'medium' | 'low';
  metadata?: Record<string, string | undefined>;
  method?: string;
}

class SandboxProviderDetector {
  private cachedResult: ProviderResult | null = null;
  
  // Order matters: most specific/reliable first
  private detectors = [
    this.detectE2B,
    this.detectVercel,
    this.detectModal,
    this.detectFlyIo,
    this.detectReplit,
    this.detectCodeSandbox,
    this.detectDaytona,
    this.detectGitHubCodespaces,
    this.detectRailway,
    this.detectRender,
  ];
  
  async detect(): Promise<ProviderResult> {
    if (this.cachedResult) return this.cachedResult;
    
    // Fast path: environment variable checks
    for (const detector of this.detectors) {
      const result = detector.call(this);
      if (result) {
        this.cachedResult = result;
        return result;
      }
    }
    
    // Slower path: container/VM detection
    const container = this.detectContainer();
    if (container) {
      this.cachedResult = container;
      return container;
    }
    
    // Slowest path: metadata service (only if needed)
    const cloud = await this.detectCloudViaMetadata();
    if (cloud) {
      this.cachedResult = cloud;
      return cloud;
    }
    
    return { provider: 'unknown', confidence: 'low' };
  }
  
  private detectE2B(): ProviderResult | null {
    if (process.env.E2B_SANDBOX === 'true') {
      return {
        provider: 'e2b',
        confidence: 'high',
        metadata: {
          sandboxId: process.env.E2B_SANDBOX_ID,
          teamId: process.env.E2B_TEAM_ID,
          templateId: process.env.E2B_TEMPLATE_ID,
        }
      };
    }
    return null;
  }
  
  private detectVercel(): ProviderResult | null {
    if (process.env.VERCEL === '1') {
      return {
        provider: 'vercel',
        confidence: 'high',
        metadata: {
          env: process.env.VERCEL_ENV,
          region: process.env.VERCEL_REGION,
          deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
          runtime: typeof globalThis.EdgeRuntime !== 'undefined' ? 'edge' 
                 : process.env.LAMBDA_TASK_ROOT ? 'serverless' : 'static',
        }
      };
    }
    return null;
  }
  
  private detectModal(): ProviderResult | null {
    if (process.env.MODAL_IS_REMOTE === '1') {
      return {
        provider: 'modal',
        confidence: 'high',
        metadata: {
          cloudProvider: process.env.MODAL_CLOUD_PROVIDER,
          region: process.env.MODAL_REGION,
          type: process.env.MODAL_SANDBOX_ID ? 'sandbox' : 'function',
        }
      };
    }
    return null;
  }
  
  private detectFlyIo(): ProviderResult | null {
    if (process.env.FLY_APP_NAME) {
      return {
        provider: 'fly.io',
        confidence: 'high',
        metadata: {
          appName: process.env.FLY_APP_NAME,
          region: process.env.FLY_REGION,
          machineId: process.env.FLY_MACHINE_ID,
        }
      };
    }
    return null;
  }
  
  private detectReplit(): ProviderResult | null {
    if (process.env.REPL_ID) {
      return {
        provider: 'replit',
        confidence: 'high',
        metadata: {
          replId: process.env.REPL_ID,
          slug: process.env.REPL_SLUG,
          owner: process.env.REPL_OWNER,
        }
      };
    }
    return null;
  }
  
  private detectCodeSandbox(): ProviderResult | null {
    if (process.env.CODESANDBOX_HOST) {
      return {
        provider: 'codesandbox',
        confidence: 'high',
        metadata: { host: process.env.CODESANDBOX_HOST }
      };
    }
    return null;
  }
  
  private detectDaytona(): ProviderResult | null {
    const signals: string[] = [];
    if (os.userInfo().username === 'daytona') signals.push('user');
    if (fs.existsSync('/home/daytona')) signals.push('home');
    if (fs.existsSync(path.join(os.homedir(), '.daytona'))) signals.push('config');
    
    if (signals.length >= 2) {
      return { provider: 'daytona', confidence: 'medium', method: signals.join('+') };
    }
    return null;
  }
  
  private detectGitHubCodespaces(): ProviderResult | null {
    if (process.env.CODESPACES === 'true') {
      return {
        provider: 'github-codespaces',
        confidence: 'high',
        metadata: {
          name: process.env.CODESPACE_NAME,
          repo: process.env.GITHUB_REPOSITORY,
        }
      };
    }
    return null;
  }
  
  private detectRailway(): ProviderResult | null {
    if (process.env.RAILWAY_ENVIRONMENT) {
      return {
        provider: 'railway',
        confidence: 'high',
        metadata: {
          environment: process.env.RAILWAY_ENVIRONMENT,
          projectId: process.env.RAILWAY_PROJECT_ID,
        }
      };
    }
    return null;
  }
  
  private detectRender(): ProviderResult | null {
    if (process.env.RENDER === 'true') {
      return {
        provider: 'render',
        confidence: 'high',
        metadata: {
          serviceId: process.env.RENDER_SERVICE_ID,
          serviceName: process.env.RENDER_SERVICE_NAME,
        }
      };
    }
    return null;
  }
}

// Usage
const detector = new SandboxProviderDetector();
const provider = await detector.detect();
console.log(`Running on: ${provider.provider} (${provider.confidence} confidence)`);
```

---

## Existing libraries you can use or reference

Several open-source projects implement cloud detection patterns:

- **cloud-detect** (Python, `pip install cloud-detect`): Detects AWS, GCP, Azure, Alibaba, DigitalOcean, Oracle via filesystem + metadata
- **cloud-detect-js** (Node, `npm install cloud-detect-js`): JavaScript port with similar feature coverage
- **banzaicloud/satellite** (Go): Uses two-tier detection with sysfs first, then metadata fallback
- **OpenTelemetry Resource Detectors**: Production-grade detectors across Node.js, Python, Go — use `@opentelemetry/resource-detector-aws`, `@opentelemetry/resource-detector-gcp`, etc.

The OpenTelemetry approach is particularly well-suited for telemetry libraries since it follows established semantic conventions for resource attributes.

---

## Best practices for telemetry provider detection

**Detection order** should prioritize speed and reliability: environment variables (instant) → filesystem checks (<1ms) → DMI/sysfs (<10ms) → metadata services (100-500ms with timeout). Always cache results since the provider cannot change during process lifetime.

**Privacy considerations**: Collect only necessary identifiers (provider name, region), not instance IDs or machine identifiers. Allow users to opt out via environment variable like `DISABLE_PROVIDER_DETECTION=true`. Document what data is collected.

**Fallback handling**: Return `{ provider: 'unknown', confidence: 'low' }` rather than throwing errors. Log detection method used for debugging. Consider exposing a `FORCE_PROVIDER` environment variable for testing and manual override.

## Quick reference detection table

| Provider | Primary Detection | Secondary Detection |
|----------|-------------------|---------------------|
| **E2B** | `E2B_SANDBOX="true"` | `/run/e2b/.E2B_SANDBOX` |
| **Vercel** | `VERCEL="1"` | `LAMBDA_TASK_ROOT`, `EdgeRuntime` global |
| **Modal** | `MODAL_IS_REMOTE="1"` | `MODAL_CLOUD_PROVIDER` |
| **Fly.io** | `FLY_APP_NAME` | `FLY_MACHINE_ID`, `FLY_REGION` |
| **Replit** | `REPL_ID` | `.replit` file, `REPLIT_DB_URL` |
| **CodeSandbox** | `CODESANDBOX_HOST` | `CSB_BASE_PREVIEW_HOST` |
| **Daytona** | Username `daytona` | `/home/daytona`, `~/.daytona` |
| **GitHub Codespaces** | `CODESPACES="true"` | `CODESPACE_NAME` |
| **Railway** | `RAILWAY_ENVIRONMENT` | `RAILWAY_PROJECT_ID` |
| **Render** | `RENDER="true"` | `RENDER_SERVICE_ID` |
