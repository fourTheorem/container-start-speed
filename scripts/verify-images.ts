import { spawnSync } from 'child_process';
import { parseArgs } from 'util';

type ImageSize = 'small' | 'large';
type Compression = 'gzip' | 'zstd' | 'uncompressed';
type SociMode = 'plain' | 'soci';
type CpuArch = 'x86_64' | 'arm64';

interface Args {
  stackName: string;
  region?: string;
  repositoryUri?: string;
  architectures: CpuArch[];
  sizes: ImageSize[];
  imageFormats: ImageFormat[];
}

interface StackOutputs {
  RepositoryUri: string;
}

interface BatchGetImageResponse {
  images?: Array<{
    imageId?: {
      imageDigest?: string;
      imageTag?: string;
    };
    imageManifest?: string;
    imageManifestMediaType?: string;
  }>;
  failures?: Array<Record<string, unknown>>;
}

interface OciIndex {
  mediaType?: string;
  manifests?: Array<{
    mediaType?: string;
    digest?: string;
    artifactType?: string;
    platform?: {
      architecture?: string;
      os?: string;
    };
    annotations?: Record<string, string>;
  }>;
}

interface ImageManifest {
  mediaType?: string;
  layers?: Array<{
    mediaType?: string;
    digest?: string;
    size?: number;
  }>;
}

interface VerificationResult {
  tag: string;
  expectedCompression: Compression;
  imageDigest: string;
  manifestMediaType: string;
  layerMediaTypes: string[];
  sociArtifactDigest?: string;
  errors: string[];
}

interface ImageFormat {
  compression: Compression;
  sociMode: SociMode;
}

const IMAGE_SIZES: ImageSize[] = ['small', 'large'];
const IMAGE_FORMATS: ImageFormat[] = [
  { compression: 'gzip', sociMode: 'plain' },
  { compression: 'gzip', sociMode: 'soci' },
  { compression: 'zstd', sociMode: 'plain' },
  { compression: 'uncompressed', sociMode: 'plain' },
  { compression: 'uncompressed', sociMode: 'soci' },
];
const CPU_ARCHITECTURES: CpuArch[] = ['x86_64', 'arm64'];

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const DOCKER_MANIFEST_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const SOCI_ARTIFACT = 'application/vnd.amazon.soci.index.v2+json';

const args = parseArgsOrExit(process.argv.slice(2));
const repositoryUri = args.repositoryUri ?? getStackOutputs(args.stackName, args.region).RepositoryUri;
const repositoryName = repositoryUri.split('/').pop();
if (!repositoryName) {
  throw new Error(`Could not infer ECR repository name from ${repositoryUri}`);
}

const results: VerificationResult[] = [];
for (const cpuArchitecture of args.architectures) {
  for (const size of args.sizes) {
    for (const { compression, sociMode } of args.imageFormats) {
      const tag = `${cpuArchitecture}-${size}-${compression}-${sociMode}`;
      results.push(verifyTag(repositoryName, tag, cpuArchitecture, compression, sociMode));
    }
  }
}

let failures = 0;
for (const result of results) {
  if (result.errors.length > 0) {
    failures++;
    console.log(`FAIL ${result.tag}`);
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  } else {
    console.log(`OK   ${result.tag}`);
  }
  console.log(`     imageDigest=${result.imageDigest}`);
  if (result.sociArtifactDigest) {
    console.log(`     sociArtifactDigest=${result.sociArtifactDigest}`);
  }
  for (const mediaType of unique(result.layerMediaTypes)) {
    console.log(`     layerMediaType=${mediaType}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} image tag(s) failed verification.`);
}

console.log(`Verified ${results.length} image tags in ${repositoryName}.`);

function parseArgsOrExit(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      stack: { type: 'string' },
      region: { type: 'string' },
      'repository-uri': { type: 'string' },
      architectures: { type: 'string' },
      sizes: { type: 'string' },
      formats: { type: 'string' },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  return {
    stackName: values.stack ?? process.env.STACK_NAME ?? 'ContainerStartSpeedStack',
    region: values.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
    repositoryUri: values['repository-uri'] ?? process.env.REPOSITORY_URI,
    architectures: parseList<CpuArch>(values.architectures ?? process.env.ARCHITECTURES, CPU_ARCHITECTURES, 'architectures'),
    sizes: parseList<ImageSize>(values.sizes ?? process.env.IMAGE_SIZES, IMAGE_SIZES, 'sizes'),
    imageFormats: parseImageFormats(values.formats ?? process.env.IMAGE_FORMATS),
  };
}

function printHelp() {
  console.log(`Verify pushed ECR benchmark image compression and SOCI artifacts.

Usage:
  npm run verify-images -- [options]

Options:
  -h, --help                  Show this help.
      --stack <name>          CloudFormation stack name. Default: ContainerStartSpeedStack
      --region <region>       AWS region. Defaults to AWS CLI/environment resolution.
      --repository-uri <uri>   ECR repository URI. Defaults to stack output RepositoryUri.
      --architectures <csv>   x86_64,arm64. Default: all
      --sizes <csv>           small,large. Default: all
      --formats <csv>         gzip:plain,gzip:soci,zstd:plain,uncompressed:plain,uncompressed:soci. Default: all

Environment:
  STACK_NAME, AWS_REGION, AWS_DEFAULT_REGION, REPOSITORY_URI, ARCHITECTURES,
  IMAGE_SIZES, IMAGE_FORMATS
`);
}

function parseList<T extends string>(value: string | undefined, allowedValues: T[], optionName: string): T[] {
  if (!value || value === 'all') {
    return allowedValues;
  }
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = parsed.filter((item) => !allowedValues.includes(item as T));
  if (invalid.length > 0) {
    throw new Error(`--${optionName} contains invalid value(s): ${invalid.join(', ')}. Allowed: ${allowedValues.join(', ')}`);
  }
  if (parsed.length === 0) {
    throw new Error(`--${optionName} must not be empty`);
  }
  return parsed as T[];
}

function parseImageFormats(value: string | undefined): ImageFormat[] {
  if (!value || value === 'all') {
    return IMAGE_FORMATS;
  }
  const allowedValues = IMAGE_FORMATS.map(formatLabel);
  const parsed = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = parsed.filter((item) => !allowedValues.includes(item));
  if (invalid.length > 0) {
    throw new Error(`--formats contains invalid value(s): ${invalid.join(', ')}. Allowed: ${allowedValues.join(', ')}`);
  }
  if (parsed.length === 0) {
    throw new Error('--formats must not be empty');
  }
  return parsed.map((item) => {
    const [compression, sociMode] = item.split(':') as [Compression, SociMode];
    return { compression, sociMode };
  });
}

function formatLabel(format: ImageFormat): string {
  return `${format.compression}:${format.sociMode}`;
}

function verifyTag(
  repositoryNameValue: string,
  tag: string,
  cpuArchitecture: CpuArch,
  expectedCompression: Compression,
  sociMode: SociMode,
): VerificationResult {
  const tagImage = batchGetImage(repositoryNameValue, [`imageTag=${tag}`], [
    OCI_INDEX,
    DOCKER_MANIFEST_LIST,
    OCI_MANIFEST,
    DOCKER_MANIFEST,
  ]);
  const tagManifest = parseManifest<OciIndex | ImageManifest>(tagImage.imageManifest, tag);
  const result: VerificationResult = {
    tag,
    expectedCompression,
    imageDigest: tagImage.imageId?.imageDigest ?? '<unknown>',
    manifestMediaType: tagImage.imageManifestMediaType ?? tagManifest.mediaType ?? '<unknown>',
    layerMediaTypes: [],
    errors: [],
  };

  let imageManifestDigest = tagImage.imageId?.imageDigest;
  let imageManifest = tagManifest as ImageManifest;

  if (isIndex(tagManifest)) {
    const platformArchitecture = ociArchitecture(cpuArchitecture);
    const imageEntry = tagManifest.manifests?.find((entry) =>
      entry.artifactType !== SOCI_ARTIFACT
      && entry.platform?.architecture === platformArchitecture
      && entry.platform?.os === 'linux'
    );
    if (!imageEntry?.digest) {
      result.errors.push(`No linux/${platformArchitecture} image manifest found in index.`);
      return result;
    }

    const sociEntry = tagManifest.manifests?.find((entry) => entry.artifactType === SOCI_ARTIFACT);
    result.sociArtifactDigest = imageEntry.annotations?.['com.amazon.soci.index-digest'] ?? sociEntry?.digest;
    imageManifestDigest = imageEntry.digest;
    const image = batchGetImage(repositoryNameValue, [`imageDigest=${imageEntry.digest}`], [OCI_MANIFEST, DOCKER_MANIFEST]);
    imageManifest = parseManifest<ImageManifest>(image.imageManifest, imageEntry.digest);
  }

  result.imageDigest = imageManifestDigest ?? result.imageDigest;
  result.layerMediaTypes = (imageManifest.layers ?? []).map((layer) => layer.mediaType ?? '<missing>');
  if (result.layerMediaTypes.length === 0) {
    result.errors.push('Image manifest contains no layers.');
  }

  const badLayerMediaTypes = result.layerMediaTypes.filter((mediaType) => !layerMatchesCompression(mediaType, expectedCompression));
  if (badLayerMediaTypes.length > 0) {
    result.errors.push(`Expected ${expectedCompression} layers, but found: ${unique(badLayerMediaTypes).join(', ')}`);
  }

  if (sociMode === 'soci' && !result.sociArtifactDigest) {
    result.errors.push('Expected SOCI artifact reference, but none was found in the image index.');
  }
  if (sociMode === 'plain' && result.sociArtifactDigest) {
    result.errors.push(`Plain image unexpectedly references SOCI artifact ${result.sociArtifactDigest}.`);
  }

  return result;
}

function batchGetImage(repositoryNameValue: string, imageIds: string[], acceptedMediaTypes: string[]) {
  const response = awsJson<BatchGetImageResponse>([
    'ecr',
    'batch-get-image',
    '--repository-name',
    repositoryNameValue,
    '--image-ids',
    ...imageIds,
    '--accepted-media-types',
    ...acceptedMediaTypes,
  ]);

  if (response.failures?.length) {
    throw new Error(`batch-get-image failures for ${imageIds.join(' ')}: ${JSON.stringify(response.failures)}`);
  }
  const image = response.images?.[0];
  if (!image?.imageManifest) {
    throw new Error(`No image manifest returned for ${imageIds.join(' ')}`);
  }
  return image;
}

function parseManifest<T>(manifest: string | undefined, subject: string): T {
  if (!manifest) {
    throw new Error(`Missing manifest for ${subject}`);
  }
  return JSON.parse(manifest) as T;
}

function isIndex(manifest: OciIndex | ImageManifest): manifest is OciIndex {
  return Array.isArray((manifest as OciIndex).manifests);
}

function layerMatchesCompression(mediaType: string, expectedCompression: Compression): boolean {
  switch (expectedCompression) {
    case 'gzip':
      return mediaType.endsWith('+gzip') || mediaType.endsWith('.gzip');
    case 'zstd':
      return mediaType.endsWith('+zstd') || mediaType.endsWith('.zstd');
    case 'uncompressed':
      return !mediaType.endsWith('+gzip')
        && !mediaType.endsWith('.gzip')
        && !mediaType.endsWith('+zstd')
        && !mediaType.endsWith('.zstd');
  }
}

function ociArchitecture(cpuArchitecture: CpuArch): string {
  return cpuArchitecture === 'x86_64' ? 'amd64' : 'arm64';
}

function getStackOutputs(stackName: string, region?: string): StackOutputs {
  const response = awsJson<{ Stacks: Array<{ Outputs?: Array<{ OutputKey: string; OutputValue: string }> }> }>([
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    stackName,
  ], region);
  const outputs = Object.fromEntries((response.Stacks[0].Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));
  return outputs as unknown as StackOutputs;
}

function awsJson<T>(command: string[], region = args.region): T {
  const finalCommand = region ? [...command, '--region', region] : command;
  const result = spawnSync('aws', [...finalCommand, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`aws ${finalCommand.join(' ')} failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
