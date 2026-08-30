import * as React from 'react';
import { ActivityIndicator, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { ToolSectionView } from '../ToolSectionView';
import { answerNotes, selectedOptionIndexes } from './inlineQuestionMatch';

export interface InlineQuestionOption {
    label: string;
    description?: string | null;
}

export interface InlineQuestion {
    id: string;
    question: string;
    header: string;
    options: InlineQuestionOption[];
    multiSelect?: boolean | null;
    required?: boolean | null;
}

export type InlineQuestionAnswers = Record<string, string[]>;

/**
 * The index of the freeform row, which sits after the last real option
 * (DROVE-53).
 *
 * A sentinel index rather than a synthetic option, so the selection state stays
 * one Set of indices and nothing downstream has to tell a real option from a
 * fake one. Selection maps back to `question.options[index]` everywhere else,
 * and that lookup is undefined here on purpose — the typed text is used
 * instead.
 */
const otherIndex = (question: InlineQuestion) => question.options.length;

interface InlineQuestionFormProps {
    questions: InlineQuestion[];
    canInteract: boolean;
    submittedAnswers?: InlineQuestionAnswers | null;
    onSubmit: (answers: InlineQuestionAnswers) => Promise<void>;
}

// This is the shared choice form used by both Claude's AskUserQuestion tool and
// agent communications such as Codex/Happy request_user_input. Transport and
// answer payload differences stay in the small wrappers around this view.
export const InlineQuestionForm = React.memo<InlineQuestionFormProps>((props) => {
    const { questions, onSubmit } = props;
    const { theme } = useUnistyles();
    const [selections, setSelections] = React.useState<Map<string, Set<number>>>(new Map());
    // What was typed into the "Something else" row, per question. The wrist has
    // been able to answer a question in words since it grew TextFieldLink, and
    // the phone could not — so the answer that is not on the list, which is the
    // one worth interrupting somebody for, had to be given on a watch or not at
    // all (DROVE-53).
    const [otherText, setOtherText] = React.useState<Map<string, string>>(new Map());
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const [locallySubmittedAnswers, setLocallySubmittedAnswers] = React.useState<InlineQuestionAnswers | null>(null);
    const questionKey = questions.map(question => question.id).join('\u0000');

    React.useEffect(() => {
        setSelections(new Map());
        setOtherText(new Map());
        setLocallySubmittedAnswers(null);
        setIsSubmitting(false);
    }, [questionKey]);

    const submittedAnswers = props.submittedAnswers ?? locallySubmittedAnswers;
    const canInteract = props.canInteract && submittedAnswers === null;

    // Which options an already-given answer picked. See inlineQuestionMatch
    // for why an answer is not always exactly a label.
    const answeredSelections = React.useMemo(() => {
        const map = new Map<string, Set<number>>();
        if (!submittedAnswers) return map;
        for (const question of questions) {
            map.set(question.id, selectedOptionIndexes(question.options, submittedAnswers[question.id]));
        }
        return map;
    }, [questions, submittedAnswers]);

    const allQuestionsAnswered = questions.every((question) => {
        if (question.required === false) return true;
        const selected = selections.get(question.id);
        if (!selected || selected.size === 0) return false;
        // A ticked "Something else" with nothing typed in it is not an answer.
        // Submitting it would send an empty string, which the bus refuses with
        // a 400 and the session never hears about.
        if (selected.has(otherIndex(question)) && !(otherText.get(question.id) ?? '').trim()) {
            return selected.size > 1;
        }
        return true;
    });

    const handleOptionToggle = React.useCallback((question: InlineQuestion, optionIndex: number) => {
        if (!canInteract) return;

        setSelections(previous => {
            const next = new Map(previous);
            const current = previous.get(question.id) ?? new Set<number>();
            if (question.multiSelect) {
                const selected = new Set(current);
                if (selected.has(optionIndex)) {
                    selected.delete(optionIndex);
                } else {
                    selected.add(optionIndex);
                }
                next.set(question.id, selected);
            } else {
                next.set(question.id, new Set([optionIndex]));
            }
            return next;
        });
    }, [canInteract]);

    const handleSubmit = React.useCallback(async () => {
        if (!allQuestionsAnswered || isSubmitting) return;

        const answers: InlineQuestionAnswers = {};
        for (const question of questions) {
            const selected = selections.get(question.id);
            if (!selected || selected.size === 0) continue;
            answers[question.id] = Array.from(selected)
                .map(optionIndex => (
                    optionIndex === otherIndex(question)
                        ? (otherText.get(question.id) ?? '').trim()
                        : question.options[optionIndex]?.label
                ))
                .filter((label): label is string => Boolean(label));
        }

        setIsSubmitting(true);
        setLocallySubmittedAnswers(answers);
        try {
            await onSubmit(answers);
        } catch (error) {
            setLocallySubmittedAnswers(null);
            console.error('Failed to submit question answer:', error);
        } finally {
            setIsSubmitting(false);
        }
    }, [allQuestionsAnswered, isSubmitting, onSubmit, otherText, questions, selections]);

    // An answered card keeps its question and every option on screen, with the
    // chosen one marked (DROVE-52). It used to collapse to "<header>: <answer>"
    // and, when the answer was not in `submittedAnswers` — which is every
    // question the terminal answered — to "<header>: —". Fold, never drop: the
    // ask and what it was answered with are both worth reading back.
    return (
        <ToolSectionView>
            <View style={styles.container}>
                {questions.map(question => {
                    const answered = submittedAnswers?.[question.id];
                    const selectedOptions = submittedAnswers
                        ? answeredSelections.get(question.id) ?? new Set<number>()
                        : selections.get(question.id) ?? new Set<number>();
                    const notes = answerNotes(question.options, answered);
                    return (
                        <View key={question.id} style={styles.questionSection}>
                            <View style={styles.headerChip}>
                                <Text style={styles.headerText}>{question.header}</Text>
                            </View>
                            <Text style={styles.questionText}>{question.question}</Text>
                            <View style={styles.optionsContainer}>
                                {question.options.map((option, optionIndex) => {
                                    const isSelected = selectedOptions.has(optionIndex);
                                    return (
                                        <TouchableOpacity
                                            key={`${question.id}:${optionIndex}`}
                                            style={[
                                                styles.optionButton,
                                                isSelected && styles.optionButtonSelected,
                                                // The chosen option stays bright once the card is
                                                // settled; only the roads not taken dim.
                                                !canInteract && !isSelected && styles.optionButtonDisabled,
                                            ]}
                                            onPress={() => handleOptionToggle(question, optionIndex)}
                                            disabled={!canInteract}
                                            activeOpacity={0.7}
                                        >
                                            {question.multiSelect ? (
                                                <View style={[
                                                    styles.checkboxOuter,
                                                    isSelected && styles.checkboxOuterSelected,
                                                ]}>
                                                    {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                                                </View>
                                            ) : (
                                                <View style={[
                                                    styles.radioOuter,
                                                    isSelected && styles.radioOuterSelected,
                                                ]}>
                                                    {isSelected && <View style={styles.radioInner} />}
                                                </View>
                                            )}
                                            <View style={styles.optionContent}>
                                                <Text style={styles.optionLabel}>{option.label}</Text>
                                                {option.description ? (
                                                    <Text style={styles.optionDescription}>{option.description}</Text>
                                                ) : null}
                                            </View>
                                        </TouchableOpacity>
                                    );
                                })}
                                {/*
                                  The freeform row, offered on EVERY question
                                  rather than only where the producer asked for
                                  one. The options are the agent's guess at what
                                  you might say, and the answer that is not among
                                  them is exactly the one worth a prompt. It
                                  looks like an option and behaves like one — the
                                  same radio or checkbox, the same selection
                                  state — so a multi-select can tick two boxes
                                  and add a note.
                                */}
                                {(() => {
                                    const index = question.options.length;
                                    const isSelected = selectedOptions.has(index);
                                    return (
                                        <View>
                                            <TouchableOpacity
                                                key={`${question.id}:other`}
                                                style={[
                                                    styles.optionButton,
                                                    isSelected && styles.optionButtonSelected,
                                                    !canInteract && styles.optionButtonDisabled,
                                                ]}
                                                onPress={() => handleOptionToggle(question, index)}
                                                disabled={!canInteract}
                                                activeOpacity={0.7}
                                            >
                                                {question.multiSelect ? (
                                                    <View style={[
                                                        styles.checkboxOuter,
                                                        isSelected && styles.checkboxOuterSelected,
                                                    ]}>
                                                        {isSelected && <Ionicons name="checkmark" size={14} color="#fff" />}
                                                    </View>
                                                ) : (
                                                    <View style={[
                                                        styles.radioOuter,
                                                        isSelected && styles.radioOuterSelected,
                                                    ]}>
                                                        {isSelected && <View style={styles.radioInner} />}
                                                    </View>
                                                )}
                                                <View style={styles.optionContent}>
                                                    <Text style={styles.optionLabel}>
                                                        {t('tools.askUserQuestion.other')}
                                                    </Text>
                                                    <Text style={styles.optionDescription}>
                                                        {t('tools.askUserQuestion.otherDescription')}
                                                    </Text>
                                                </View>
                                            </TouchableOpacity>
                                            {isSelected && (
                                                <TextInput
                                                    style={styles.otherInput}
                                                    value={otherText.get(question.id) ?? ''}
                                                    onChangeText={(value) => setOtherText((previous) => {
                                                        const next = new Map(previous);
                                                        next.set(question.id, value);
                                                        return next;
                                                    })}
                                                    editable={canInteract}
                                                    multiline
                                                    autoFocus
                                                    placeholder={t('tools.askUserQuestion.otherPlaceholder')}
                                                    placeholderTextColor={theme.colors.textSecondary}
                                                />
                                            )}
                                        </View>
                                    );
                                })()}
                            </View>
                            {notes.length > 0 && (
                                <View style={styles.submittedItem}>
                                    <Text style={styles.submittedHeader}>{question.header}:</Text>
                                    <Text style={styles.submittedValue}>{notes.join(', ')}</Text>
                                </View>
                            )}
                        </View>
                    );
                })}

                {canInteract && (
                    <View style={styles.actionsContainer}>
                        <TouchableOpacity
                            style={[
                                styles.submitButton,
                                allQuestionsAnswered && !isSubmitting && styles.submitButtonReady,
                                (!allQuestionsAnswered || isSubmitting) && styles.submitButtonDisabled,
                            ]}
                            onPress={handleSubmit}
                            disabled={!allQuestionsAnswered || isSubmitting}
                            activeOpacity={0.7}
                        >
                            {isSubmitting ? (
                                <ActivityIndicator
                                    size="small"
                                    color={Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text })}
                                />
                            ) : (
                                <Text style={styles.submitButtonText}>{t('tools.askUserQuestion.submit')}</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </ToolSectionView>
    );
});

// Kept visually identical to the existing AskUserQuestion experience.
const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    questionSection: {
        gap: 8,
    },
    headerChip: {
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        marginBottom: 4,
    },
    headerText: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
    },
    questionText: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 8,
    },
    optionsContainer: {
        gap: 4,
    },
    optionButton: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 12,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
        minHeight: 44,
    },
    optionButtonSelected: {
        backgroundColor: Platform.select({ web: theme.colors.surfaceHigh, default: theme.colors.surfaceHighest }),
        borderColor: theme.colors.radio.active,
    },
    optionButtonDisabled: {
        opacity: 0.6,
    },
    radioOuter: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    radioOuterSelected: {
        borderColor: theme.colors.radio.active,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.radio.dot,
    },
    checkboxOuter: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    checkboxOuterSelected: {
        borderColor: theme.colors.radio.active,
        backgroundColor: theme.colors.radio.active,
    },
    optionContent: {
        flex: 1,
    },
    otherInput: {
        marginTop: 4,
        minHeight: 44,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.radio.active,
        backgroundColor: Platform.select({ web: 'transparent', default: theme.colors.surface }),
        color: theme.colors.text,
        fontSize: 14,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
    actionsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
        justifyContent: 'flex-end',
    },
    submitButton: {
        backgroundColor: Platform.select({ web: theme.colors.button.primary.background, default: theme.colors.surfaceHighest }),
        borderWidth: Platform.select({ web: 0, default: 1 }),
        borderColor: theme.colors.divider,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 44,
    },
    submitButtonDisabled: {
        opacity: 0.5,
    },
    submitButtonReady: {
        borderColor: theme.colors.radio.active,
    },
    submitButtonText: {
        color: Platform.select({ web: theme.colors.button.primary.tint, default: theme.colors.text }),
        fontSize: 14,
        fontWeight: '600',
    },
    submittedItem: {
        flexDirection: 'row',
        gap: 8,
    },
    submittedHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    submittedValue: {
        fontSize: 13,
        color: theme.colors.text,
        flex: 1,
    },
}));