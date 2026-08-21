import { describe, expect, it } from 'vitest';
import { parseNetatalkExtensionMap, serializeNetatalkExtensionMap } from './extension-map-netatalk';

const sample = `# header
.         "????"  "????"      Unix Binary
.bin      "SIT!"  "SITx"      MacBinary                      StuffIt Expander
#.txt      "TEXT"  "ttxt"      ASCII Text
`;

describe('Netatalk extension map', () => {
  it('parses enabled lines and keeps trailing comment text', () => {
    const rows = parseNetatalkExtensionMap(sample);
    expect(rows).toEqual([
      { extension: '.', type: '????', creator: '????', comment: 'Unix Binary' },
      { extension: 'bin', type: 'SIT!', creator: 'SITx', comment: 'MacBinary                      StuffIt Expander' },
    ]);
  });

  it('replaces enabled lines in place and keeps comments', () => {
    const next = serializeNetatalkExtensionMap(
      [
        { extension: 'bin', type: 'SIT!', creator: 'SITx', comment: 'MacBinary' },
        { extension: 'png', type: 'PNG ', creator: 'ogle', comment: 'PNG' },
      ],
      sample,
    );
    expect(next).toContain('# header');
    expect(next).toContain('#.txt      "TEXT"  "ttxt"      ASCII Text');
    expect(next).not.toContain('Unix Binary');
    expect(next).toContain('.bin "SIT!" "SITx"      MacBinary');
    expect(next).toContain('.png "PNG " "ogle"      PNG');
  });
});
