import * as React from 'react';
import { Text, TextInput, Platform, View, NativeSyntheticEvent, TextInputContentSizeChangeEventData, TextInputKeyPressEventData, TextInputSelectionChangeEventData } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { resolveMultiTextInputLayout } from './multiTextInputLayout';

export type SupportedKey = 'Enter' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Tab';

export interface KeyPressEvent {
    key: SupportedKey;
    shiftKey: boolean;
}

export type OnKeyPressCallback = (event: KeyPressEvent) => boolean;

export const MULTI_TEXT_INPUT_FONT_SIZE = 16;
export const MULTI_TEXT_INPUT_LINE_HEIGHT = 22;

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}

export interface MultiTextInputHandle {
    getText: () => string;
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

// Either `value` (controlled) or `defaultValue` (uncontrolled) must be set.
// "Uncontrolled" here means uncontrolled *from the parent's perspective*: the
// parent never passes `value`, so it never re-renders on every keystroke (the
// perf goal). Internally the native input is always `value`-driven, because on
// the New Architecture (Fabric) `setNativeProps({ text })` is a no-op — driving
// `value` is the only text path that actually clears/replaces the field.
interface MultiTextInputProps {
    value?: string;
    defaultValue?: string;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    editable?: boolean;
    maxHeight?: number;
    lineHeight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    multiline?: boolean;
    returnKeyType?: React.ComponentProps<typeof TextInput>['returnKeyType'];
    submitBehavior?: React.ComponentProps<typeof TextInput>['submitBehavior'];
    onSubmitEditing?: () => void;
    onKeyPress?: OnKeyPressCallback;
    onSelectionChange?: (selection: { start: number; end: number }) => void;
    onStateChange?: (state: TextInputState) => void;
}

export const MultiTextInput = React.memo(React.forwardRef<MultiTextInputHandle, MultiTextInputProps>((props, ref) => {
    const {
        value,
        defaultValue,
        onChangeText,
        placeholder,
        editable = true,
        maxHeight = 120,
        lineHeight = MULTI_TEXT_INPUT_LINE_HEIGHT,
        multiline = true,
        returnKeyType = 'default',
        submitBehavior = multiline ? 'newline' : 'blurAndSubmit',
        onSubmitEditing,
        onKeyPress,
        onSelectionChange,
        onStateChange
    } = props;

    const isControlled = value !== undefined;
    const isControlledRef = React.useRef(isControlled);
    isControlledRef.current = isControlled;
    const { theme } = useUnistyles();
    // Track latest selection in a ref
    const selectionRef = React.useRef({ start: 0, end: 0 });
    const inputRef = React.useRef<TextInput>(null);
    // In uncontrolled mode we own the text locally and bind it to the native
    // input's `value`. Keystrokes update this state (re-rendering only this
    // small component, never the parent), and imperative sets flow through it
    // too — the only mutation path Fabric honors.
    const [uncontrolledText, setUncontrolledText] = React.useState<string>(defaultValue ?? '');
    const text = isControlled ? value! : uncontrolledText;
    // Synchronous mirror so imperative getText() never lags a state commit.
    const latestTextRef = React.useRef<string>(text);
    latestTextRef.current = text;
    // Caret to apply after an imperative text set. Applied in a layout effect
    // so it runs once the new `value` is committed to the native view, using
    // TextInput.setSelection() (Fabric's supported imperative caret API).
    const pendingSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
    const [, bumpSelectionTick] = React.useReducer((c: number) => c + 1, 0);
    React.useLayoutEffect(() => {
        const sel = pendingSelectionRef.current;
        if (sel && inputRef.current) {
            pendingSelectionRef.current = null;
            inputRef.current.setSelection(sel.start, sel.end);
        }
    });
    /**
     * WHAT THE FIELD MEASURED, AND THE TEXT IT MEASURED IT ON (DROVE-350).
     *
     * Clay: "After speaking into the speech bubble and then submitting, it
     * leaves all this random empty space." The photograph is the composer
     * holding the empty placeholder inside a bubble still as tall as the four
     * dictated lines.
     *
     * The field had no resolved height at all: the row carries a floor and a
     * ceiling and everything between them was this input's intrinsic
     * measurement. That is fine while every write is a keystroke, and it is not
     * fine for the composer, where BOTH of the writes that matter are
     * programmatic — dictation puts the transcript in through
     * `setTextAndSelection`, and the send takes it out the same way. Neither
     * carries a native text-change event, and an iOS field measures from the
     * most recent attributed string it was TOLD about, falling back to the state
     * the native view last reported when the react tree's own string has not
     * moved since that report. So the tall measurement outlived the clear and
     * nothing recomputed a height from the value.
     *
     * THE MEASUREMENT IS KEYED TO ITS TEXT, which is what makes this a
     * derivation rather than a cache. A content size is only trusted for the
     * string it was taken on; anything else is treated as unmeasured, and an
     * unmeasured non-empty field falls back to the intrinsic sizing it has
     * always had. What is NOT left to the native view is the empty case:
     * `resolveMultiTextInputLayout` answers the one-line floor for a value with
     * nothing in it whatever was last measured, which is the same `hasText`
     * guard Home has used since DROVE-345 and the whole of the difference
     * between a composer that comes back and one that does not.
     *
     * No timer, and no offset anybody worked out (DROVE-214, DROVE-320): the
     * height is the resolver's, read off the value.
     */
    const [measured, setMeasured] = React.useState<{ text: string; height: number }>({ text: '', height: 0 });
    const handleContentSizeChange = React.useCallback((
        e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
    ) => {
        const height = Math.ceil(e.nativeEvent.contentSize.height);
        setMeasured((current) => (
            current.height === height && current.text === latestTextRef.current
                ? current
                : { text: latestTextRef.current, height }
        ));
    }, []);
    const layout = resolveMultiTextInputLayout({
        contentHeight: measured.text === text ? measured.height : 0,
        hasText: text.length > 0,
        maxHeight,
        lineHeight,
        paddingTop: props.paddingTop ?? 0,
        paddingBottom: props.paddingBottom ?? 0,
    });
    /**
     * The height the field is drawn at, or `undefined` where the native view's
     * own measurement is still the better answer.
     *
     * A single-line field never grows, so it has nothing to come back from and
     * is left alone. A multiline field that is EMPTY is always resolved, because
     * that is the state the stale measurement strands. One that holds text is
     * resolved once it has reported a size for that text, and until then keeps
     * the intrinsic sizing it has always had — so a draft restored on session
     * open never flashes at one line on its way to its real height.
     */
    const resolvedHeight = multiline && (text.length === 0 || measured.text === text)
        ? layout.height
        : undefined;
    const textStyle = {
        width: '100%' as const,
        fontSize: MULTI_TEXT_INPUT_FONT_SIZE,
        lineHeight,
        maxHeight,
        height: resolvedHeight,
        color: theme.colors.input.text,
        textAlignVertical: multiline ? 'top' as const : 'center' as const,
        padding: 0,
        paddingTop: props.paddingTop,
        paddingBottom: props.paddingBottom,
        paddingLeft: props.paddingLeft,
        paddingRight: props.paddingRight,
        opacity: editable ? 1 : 0.58,
        ...Typography.default(),
    };

    React.useEffect(() => {
        if (!editable) {
            inputRef.current?.blur();
        }
    }, [editable]);

    const handleKeyPress = React.useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        if (!editable || !onKeyPress) return;

        const nativeEvent = e.nativeEvent;
        const key = nativeEvent.key;
        
        // Map native key names to our normalized format
        let normalizedKey: SupportedKey | null = null;
        
        switch (key) {
            case 'Enter':
                normalizedKey = 'Enter';
                break;
            case 'Escape':
                normalizedKey = 'Escape';
                break;
            case 'ArrowUp':
            case 'Up': // iOS may use different names
                normalizedKey = 'ArrowUp';
                break;
            case 'ArrowDown':
            case 'Down':
                normalizedKey = 'ArrowDown';
                break;
            case 'ArrowLeft':
            case 'Left':
                normalizedKey = 'ArrowLeft';
                break;
            case 'ArrowRight':
            case 'Right':
                normalizedKey = 'ArrowRight';
                break;
            case 'Tab':
                normalizedKey = 'Tab';
                break;
        }

        if (normalizedKey) {
            const keyEvent: KeyPressEvent = {
                key: normalizedKey,
                shiftKey: (nativeEvent as any).shiftKey || false
            };
            
            const handled = onKeyPress(keyEvent);
            if (handled) {
                e.preventDefault();
            }
        }
    }, [editable, onKeyPress]);

    const handleTextChange = React.useCallback((text: string) => {
        latestTextRef.current = text;
        if (!isControlledRef.current) {
            setUncontrolledText(text);
        }
        // When text changes, assume cursor moves to end
        const selection = { start: text.length, end: text.length };
        selectionRef.current = selection;

        onChangeText?.(text);

        if (onStateChange) {
            onStateChange({ text, selection });
        }
        if (onSelectionChange) {
            onSelectionChange(selection);
        }
    }, [onChangeText, onStateChange, onSelectionChange]);

    const handleSelectionChange = React.useCallback((e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        if (e.nativeEvent.selection) {
            const { start, end } = e.nativeEvent.selection;
            const selection = { start, end };

            // Only update if selection actually changed
            if (selection.start !== selectionRef.current.start || selection.end !== selectionRef.current.end) {
                selectionRef.current = selection;

                if (onSelectionChange) {
                    onSelectionChange(selection);
                }
                if (onStateChange) {
                    onStateChange({ text: latestTextRef.current, selection });
                }
            }
        }
    }, [onSelectionChange, onStateChange]);

    // Imperative handle for direct control
    React.useImperativeHandle(ref, () => ({
        getText: () => latestTextRef.current,
        setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
            // Drive the native input through `value` — Fabric ignores
            // setNativeProps({ text }), so this is the only path that actually
            // clears/replaces the field. The caret is applied in the layout
            // effect once the new text is committed natively. bumpSelectionTick
            // forces a render even when the text is unchanged (e.g. Escape
            // collapsing the autocomplete selection) so the caret still applies.
            latestTextRef.current = text;
            selectionRef.current = selection;
            pendingSelectionRef.current = selection;
            if (!isControlledRef.current) {
                setUncontrolledText(text);
            }
            bumpSelectionTick();

            // Notify through callbacks
            onChangeText?.(text);
            if (onStateChange) {
                onStateChange({ text, selection });
            }
            if (onSelectionChange) {
                onSelectionChange(selection);
            }
        },
        focus: () => {
            inputRef.current?.focus();
        },
        blur: () => {
            inputRef.current?.blur();
        }
    }), [onChangeText, onStateChange, onSelectionChange]);

    const displayText = text;

    return (
        <View style={{ width: '100%' }}>
            {editable ? (
                <TextInput
                    ref={inputRef}
                    style={textStyle}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={text}
                    editable={editable}
                    onChangeText={handleTextChange}
                    onContentSizeChange={handleContentSizeChange}
                    onKeyPress={handleKeyPress}
                    onSelectionChange={handleSelectionChange}
                    multiline={multiline}
                    autoCapitalize="sentences"
                    autoCorrect={true}
                    keyboardType="default"
                    returnKeyType={returnKeyType}
                    autoComplete="off"
                    textContentType="none"
                    submitBehavior={submitBehavior}
                    onSubmitEditing={onSubmitEditing}
                />
            ) : (
                <View pointerEvents="none">
                    <Text
                        style={[
                            textStyle,
                            {
                                color: displayText ? theme.colors.input.text : theme.colors.input.placeholder,
                            },
                        ]}
                    >
                        {displayText || placeholder || ' '}
                    </Text>
                </View>
            )}
        </View>
    );
}));

MultiTextInput.displayName = 'MultiTextInput';
