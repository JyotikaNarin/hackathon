/** Maps Salesforce source-format file paths to metadata components. */

const TYPE_FOLDERS: Record<string, string> = {
  applications: 'CustomApplication',
  aura: 'AuraDefinitionBundle',
  classes: 'ApexClass',
  components: 'ApexComponent',
  customMetadata: 'CustomMetadata',
  flexipages: 'FlexiPage',
  flows: 'Flow',
  labels: 'CustomLabels',
  layouts: 'Layout',
  lwc: 'LightningComponentBundle',
  mutingpermissionsets: 'MutingPermissionSet',
  objects: 'CustomObject',
  pages: 'ApexPage',
  permissionsets: 'PermissionSet',
  profiles: 'Profile',
  staticresources: 'StaticResource',
  tabs: 'CustomTab',
  triggers: 'ApexTrigger',
}

const OBJECT_CHILDREN: Record<string, string> = {
  businessProcesses: 'BusinessProcess',
  compactLayouts: 'CompactLayout',
  fieldSets: 'FieldSet',
  fields: 'CustomField',
  listViews: 'ListView',
  recordTypes: 'RecordType',
  validationRules: 'ValidationRule',
  webLinks: 'WebLink',
}

/** Metadata types the Metadata API deploys as a whole file, so anything missing from the file can be lost in the target. */
export const PERMISSION_CONTAINERS = new Set(['MutingPermissionSet', 'PermissionSet', 'Profile'])

export type ComponentRef = Readonly<{id: string; name: string; type: string}>

/**
 * Stable key for a metadata file, independent of where the project keeps it:
 * `force-app/main/default/classes/Foo.cls` -> `classes/Foo.cls`. Returns undefined for non-metadata files.
 */
export function fileKey(relativePath: string): string | undefined {
  const parts = relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  const index = parts.findIndex((part) => Object.hasOwn(TYPE_FOLDERS, part))
  return index === -1 || index === parts.length - 1 ? undefined : parts.slice(index).join('/')
}

function stripExtensions(fileName: string): string {
  return fileName.replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '')
}

export function componentOf(key: string): ComponentRef {
  const parts = key.split('/')
  const folder = parts[0]
  let type = TYPE_FOLDERS[folder] ?? folder
  let name: string
  if (folder === 'aura' || folder === 'lwc' || (folder === 'staticresources' && parts.length > 2)) {
    name = parts[1]
  } else if (folder === 'objects') {
    const childType = parts.length >= 4 ? OBJECT_CHILDREN[parts[2]] : undefined
    if (childType) {
      type = childType
      name = `${parts[1]}.${stripExtensions(parts[3])}`
    } else {
      name = parts[1]
    }
  } else {
    name = stripExtensions(parts.at(-1)!)
  }

  return {id: `${type}:${name}`, name, type}
}

export function uniqueComponents(keys: Iterable<string>): ComponentRef[] {
  const byId = new Map<string, ComponentRef>()
  for (const key of keys) {
    const component = componentOf(key)
    byId.set(component.id, component)
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}
