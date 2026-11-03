import { afterEach, describe, expect, it } from 'vitest'
import { PreconditionFailed, CloudError } from './cloud'
import { parseBucketUrl, S3Cloud, signV4 } from './s3'
import { startFakeS3, type FakeS3 } from './testing/fakeS3'

describe('signV4', () => {
  it('matches the AWS test suite (get-vanilla)', () => {
    const auth = signV4({
      method: 'GET',
      path: '/',
      query: {},
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      amzDate: '20150830T123600Z',
    })
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })
})

describe('parseBucketUrl', () => {
  it('splits an S3 API URL into endpoint and bucket', () => {
    expect(parseBucketUrl('https://abc123.r2.cloudflarestorage.com/my-books')).toEqual({
      endpoint: 'https://abc123.r2.cloudflarestorage.com',
      bucket: 'my-books',
    })
    expect(parseBucketUrl(' https://abc.r2.cloudflarestorage.com ')?.bucket).toBe('')
    expect(parseBucketUrl('not a url')).toBeNull()
  })
})

describe('S3Cloud against an S3-like server', () => {
  let server: FakeS3 | null = null
  afterEach(async () => {
    await server?.close()
    server = null
  })
  const creds = { accessKeyId: 'KEY', secretAccessKey: 'SECRET/+x' }

  it('gets, puts conditionally, lists every page and deletes', async () => {
    server = await startFakeS3({ bucket: 'books', ...creds, pageSize: 2 })
    const cloud = new S3Cloud({ endpoint: server.url, bucket: 'books', ...creds })
    expect(await cloud.get('library/units/a b.json')).toBeNull()

    const first = await cloud.put('library/units/a b.json', new TextEncoder().encode('one'), {
      ifNoneMatch: '*',
    })
    await expect(
      cloud.put('library/units/a b.json', new TextEncoder().encode('x'), { ifNoneMatch: '*' }),
    ).rejects.toBeInstanceOf(PreconditionFailed)
    const got = await cloud.get('library/units/a b.json')
    expect(new TextDecoder().decode(got!.body)).toBe('one')
    expect(got!.etag).toBe(first.etag)

    await expect(
      cloud.put('library/units/a b.json', new TextEncoder().encode('two'), { ifMatch: 'stale' }),
    ).rejects.toBeInstanceOf(PreconditionFailed)
    const second = await cloud.put('library/units/a b.json', new TextEncoder().encode('two'), {
      ifMatch: first.etag,
    })
    expect(second.etag).not.toBe(first.etag)

    for (const k of ['library/blobs/1', 'library/blobs/2', 'library/blobs/3', 'other/x']) {
      await cloud.put(k, new Uint8Array([1, 2, 3]))
    }
    const listed = await cloud.list('library/')
    expect(listed.map((o) => o.key)).toEqual([
      'library/blobs/1',
      'library/blobs/2',
      'library/blobs/3',
      'library/units/a b.json',
    ])
    expect(listed[3]!.etag).toBe(second.etag)
    expect(listed[0]!.size).toBe(3)

    await cloud.delete('library/blobs/1')
    expect(await cloud.get('library/blobs/1')).toBeNull()
  })

  it('reports wrong keys and an unreachable cloud', async () => {
    server = await startFakeS3({ bucket: 'books', ...creds })
    const wrong = new S3Cloud({
      endpoint: server.url,
      bucket: 'books',
      accessKeyId: 'KEY',
      secretAccessKey: 'nope',
    })
    await expect(wrong.list('')).rejects.toMatchObject({ kind: 'auth' })
    server.failWith = 503
    const cloud = new S3Cloud({ endpoint: server.url, bucket: 'books', ...creds })
    await expect(cloud.get('x')).rejects.toMatchObject({ kind: 'offline' })
    const down = new S3Cloud({ endpoint: 'http://127.0.0.1:1', bucket: 'books', ...creds })
    await expect(down.get('x')).rejects.toBeInstanceOf(CloudError)
  })
})
