import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { highlight } from './syntax/highlight';
import { SyntaxSpans } from './syntax/SyntaxText';

interface SimpleSyntaxHighlighterProps {
  code: string;
  language: string | null;
  selectable: boolean;
}

/**
 * A highlighted code block.
 *
 * The tokeniser used to live here as a pile of hand-written regexes run per
 * line (DROVE-159 replaced it with Prism, which is already in the tree). Three
 * things changed with it:
 *
 *  - a language is sniffed when the fence did not name one, so a bare ``` block
 *    of Python is no longer flat grey;
 *  - a language we cannot place renders plain rather than being run through
 *    whatever grammar was nearest;
 *  - keywords are no longer bold. Weight is a metrics change, and a metrics
 *    change reflows the block under the read-aloud mark.
 *
 * Rainbow brackets went too. On `#f0f0f0` the old bracket colours measured
 * around 2:1, so they were decoration that could not be read.
 */
export const SimpleSyntaxHighlighter = React.memo<SimpleSyntaxHighlighterProps>(({
  code,
  language,
  selectable
}) => {
  const { theme } = useUnistyles();
  const spans = React.useMemo(() => highlight(code, language), [code, language]);

  return (
    <View>
      <Text
        selectable={selectable}
        style={{
          fontFamily: Typography.mono().fontFamily,
          fontSize: 14,
          lineHeight: 20,
          color: theme.colors.syntax.plain,
        }}
      >
        <SyntaxSpans spans={spans} palette={theme.colors.syntax} selectable={selectable} />
      </Text>
    </View>
  );
});

SimpleSyntaxHighlighter.displayName = 'SimpleSyntaxHighlighter';
