BEGIN;

INSERT INTO control.projects (id, name, enabled, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'lab-sandbox', true, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.quotas (project_id, instances, cpu_count, memory_mib, disk_gib, ipv4_addresses, snapshots, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 20, 160, 327680, 2560, 20, 60, now())
ON CONFLICT (project_id) DO NOTHING;

INSERT INTO control.networks (id, name, ipv4_cidr, gateway, dns_servers, exclusions, enabled, created_at, updated_at)
VALUES ('lab-primary', 'Lab primary', '192.0.2.0/27', '192.0.2.1', '["192.0.2.53"]', '["192.0.2.2"]', true, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.provider_profiles (
  id, provider_type, state, endpoint, cluster_alias, compute_target, image_source_reference,
  storage_target, network_attachment, resource_id_minimum, resource_id_maximum, network_id,
  credential_reference, created_at, updated_at
)
VALUES (
  'fake-lab', 'fake', 'active', 'fake://lab', 'fake-lab', 'fake-node', 'ubuntu-24-04-cloud',
  'fake-storage', 'lab-primary', 910000, 910099, 'lab-primary', 'test-only', now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.images (id, name, provider_profile_id, enabled, architecture, created_at, updated_at)
VALUES ('ubuntu-24-04-cloud', 'Ubuntu 24.04 Cloud', 'fake-lab', true, 'x86_64', now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO control.flavors (id, name, cpu_count, memory_mib, minimum_disk_gib, enabled, created_at, updated_at)
VALUES ('lab-small', 'Lab Small', 2, 4096, 32, true, now(), now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
