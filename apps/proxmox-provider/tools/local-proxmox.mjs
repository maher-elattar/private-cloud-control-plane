import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';

const hostname = process.env.LOCAL_PROXMOX_HOST?.trim() || '127.0.0.1';
const port = Number.parseInt(process.env.LOCAL_PROXMOX_PORT ?? '8443', 10);
const certificate = await readFile(
  process.env.LOCAL_PROXMOX_CERTIFICATE ?? '/tls/local-proxmox.crt',
);
const privateKey = await readFile(
  process.env.LOCAL_PROXMOX_PRIVATE_KEY ?? '/tls/local-proxmox.key',
);
const expectedAuthorization = 'PVEAPIToken=local@pve!phase4=local-secret';
const vms = new Map();
let taskSequence = 0;

function respond(response, statusCode, data) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify({ data })}\n`);
}

async function form(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function task(action) {
  taskSequence += 1;
  return `UPID:pve-lab-1:${String(taskSequence).padStart(8, '0')}:${action}:`;
}

const server = createServer({ cert: certificate, key: privateKey }, (request, response) => {
  const url = new URL(request.url ?? '/', `https://${hostname}:${port}`);
  if (request.method === 'GET' && url.pathname === '/health/live') {
    respond(response, 200, { status: 'ok' });
    return;
  }
  if (request.headers.authorization !== expectedAuthorization) {
    respond(response, 401, null);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/verification/state') {
    respond(response, 200, { count: vms.size, vmids: [...vms.keys()].sort((a, b) => a - b) });
    return;
  }

  const path = url.pathname.replace(/^\/api2\/json/, '');
  if (request.method === 'GET' && path === '/nodes/pve-lab-1/qemu') {
    respond(
      response,
      200,
      [...vms.values()].map((vm) => ({ vmid: vm.vmid })),
    );
    return;
  }
  if (request.method === 'GET' && path.includes('/tasks/')) {
    respond(response, 200, { status: 'stopped', exitstatus: 'OK' });
    return;
  }

  const configMatch = path.match(/^\/nodes\/pve-lab-1\/qemu\/(\d+)\/config$/);
  if (configMatch && request.method === 'GET') {
    const vm = vms.get(Number(configMatch[1]));
    respond(response, vm ? 200 : 404, vm?.config ?? null);
    return;
  }
  if (configMatch && request.method === 'POST') {
    void form(request).then((values) => {
      const vm = vms.get(Number(configMatch[1]));
      if (!vm) {
        respond(response, 404, null);
        return;
      }
      vm.config = {
        ...vm.config,
        ...Object.fromEntries(values),
        cores: Number(values.get('cores') ?? vm.config.cores),
        memory: Number(values.get('memory') ?? vm.config.memory),
      };
      respond(response, 200, task('config'));
    });
    return;
  }

  const statusMatch = path.match(/^\/nodes\/pve-lab-1\/qemu\/(\d+)\/status\/current$/);
  if (statusMatch && request.method === 'GET') {
    const vm = vms.get(Number(statusMatch[1]));
    respond(response, vm ? 200 : 404, vm ? { status: vm.status } : null);
    return;
  }
  const startMatch = path.match(/^\/nodes\/pve-lab-1\/qemu\/(\d+)\/status\/start$/);
  if (startMatch && request.method === 'POST') {
    const vm = vms.get(Number(startMatch[1]));
    if (!vm) {
      respond(response, 404, null);
      return;
    }
    vm.status = 'running';
    respond(response, 200, task('start'));
    return;
  }

  if (request.method === 'POST' && path === '/nodes/pve-lab-1/qemu/9000/clone') {
    void form(request).then((values) => {
      const vmid = Number(values.get('newid'));
      if (!Number.isInteger(vmid) || vms.has(vmid)) {
        respond(response, 409, null);
        return;
      }
      vms.set(vmid, {
        vmid,
        status: 'stopped',
        config: {
          description: values.get('description') ?? '',
          name: values.get('name') ?? '',
          cores: 2,
          memory: 4096,
          net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,firewall=1',
          scsi0: 'lab-storage:vm-disk-0,size=32G',
        },
      });
      respond(response, 200, task('clone'));
    });
    return;
  }

  respond(response, 404, null);
});

server.listen(port, hostname, () => {
  process.stdout.write(`${JSON.stringify({ event: 'local_proxmox_ready', port })}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
