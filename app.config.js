let localConfig;
try {
  localConfig = require('./app.config.local.json');
} catch (err) {
  throw new Error(
    'Missing app.config.local.json. Copy app.config.local.example.json to app.config.local.json and set your tenant URL. See README step 3.'
  );
}

module.exports = {
  environmentUrl: localConfig.environmentUrl,
  app: {
    name: 'Capacity & Utilization',
    version: '1.0.1',
    description: 'Audit and review resource capacity and utilization across your environment.',
    id: 'my.capacity.utilization',
    scopes: [
      {
        name: 'storage:logs:read',
        comment: 'Read logs from Grail for utilization signals',
      },
      {
        name: 'storage:metrics:read',
        comment: 'Read metrics from Grail (CPU, memory, disk, IOPS)',
      },
      {
        name: 'storage:events:read',
        comment: 'Read events from Grail (scaling, scheduling)',
      },
      {
        name: 'storage:bizevents:read',
        comment: 'Read findings bucket written by scheduled functions',
      },
      {
        name: 'storage:buckets:read',
        comment: 'Enumerate buckets / verify findings bucket',
      },
      {
        name: 'environment-api:entities:read',
        comment: 'Resolve hosts, disks, K8s workloads, ASGs (classic API)',
      },
      {
        name: 'storage:entities:read',
        comment: 'Grail `fetch dt.entity.host`: host tag / OS / cloud discovery',
      },
      {
        name: 'environment-api:metrics:read',
        comment: 'Classic-API metric fallback for non-Grail tenants',
      },
      {
        name: 'settings:objects:read',
        comment: 'Read management zones, segments, and app settings',
      },
      {
        name: 'settings:objects:write',
        comment: 'Persist user preferences (scope, snoozes, thresholds)',
      },
      {
        name: 'settings:schemas:read',
        comment: 'Discover settings schemas dynamically',
      },
      {
        name: 'app-settings:objects:read',
        comment: 'Read app-scoped settings (per-user)',
      },
      {
        name: 'app-settings:objects:write',
        comment: 'Write app-scoped settings (per-user)',
      },
    ],
    icon: './ui/assets/images/icon.png',
  },
};
