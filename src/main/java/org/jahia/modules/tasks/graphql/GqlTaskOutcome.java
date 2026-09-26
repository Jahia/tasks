package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLNonNull;

/**
 * One outcome a task can be completed with, paired with the label to show for it -- the resolved
 * counterpart of the raw {@code possibleOutcomes} strings (see
 * {@link GqlTaskBoard#getPossibleOutcomeDetails(String)} for how the label is looked up).
 *
 * <p>Both halves are needed by a caller rendering a decision button: the label is what the button
 * says, and the name is what {@code completeTask(outcome:)} has to be given -- they are not
 * interchangeable, since the label is localized and the name never is.
 */
@GraphQLDescription("An outcome a task can be completed with, together with the label to display for it")
public class GqlTaskOutcome {

    private final String name;
    private final String displayLabel;

    GqlTaskOutcome(String name, String displayLabel) {
        this.name = name;
        this.displayLabel = displayLabel;
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("The raw outcome value, exactly as stored in possibleOutcomes -- this, not the label, is "
            + "what completeTask(outcome:) expects")
    public String getName() {
        return name;
    }

    @GraphQLField
    @GraphQLNonNull
    @GraphQLDescription("The outcome's label in the requested language, resolved from the workflow's own resource "
            + "bundle; the capitalized raw outcome when the workflow declares no label for it")
    public String getDisplayLabel() {
        return displayLabel;
    }
}
