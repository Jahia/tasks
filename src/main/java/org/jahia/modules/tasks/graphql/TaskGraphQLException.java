package org.jahia.modules.tasks.graphql;

import org.jahia.modules.graphql.provider.dxm.DataFetchingException;

/**
 * Every task-board GraphQL failure this module raises deliberately: the rejected preconditions
 * ("Only an active task can be assigned", "This task is already claimed by another user (...)"),
 * the authorization refusals ("You are not eligible to be assigned this task"), and the unchecked
 * wrapping of a checked JCR {@code RepositoryException} raised while resolving a field -- which
 * also lets field getters stay usable as plain method references (e.g. in stream pipelines)
 * without a throws clause.
 *
 * <p><b>Why it extends graphql-dxm-provider's {@link DataFetchingException}.</b> That is the
 * provider's own thin subclass of {@code BaseGqlClientException}, and
 * {@code BaseGqlClientException} is the marker the entire client-visible-error path keys on:
 * {@code JahiaDataFetchingExceptionHandler#transformException} maps an exception extending it to a
 * {@code DXGraphQLError} (a real {@code GraphQLError}, carrying {@code getMessage()}), and
 * everything else to a plain {@code ExceptionWhileDataFetching} -- which graphql-java-servlet's
 * {@code DefaultGraphQLErrorHandler} then replaces wholesale with the generic
 * "Internal Server Error(s) while executing query". Before this, every message below reached the
 * server log and nothing else, so the board could only ever say "something went wrong".
 * Extending the provider's {@code DataFetchingException} rather than
 * {@code BaseGqlClientException} directly keeps the constructor shapes this class already had (no
 * {@code ErrorType} argument to thread through ~30 call sites) and reuses the classification the
 * provider itself applies to a failure raised while fetching a field, so the response carries
 * {@code errorType: "DataFetchingException"}.
 *
 * <p><b>What this deliberately does NOT widen.</b> Only the messages written in this module become
 * client-visible. A JCR/OSGi/workflow exception that escapes unwrapped (e.g. the
 * {@code ItemNotFoundException} {@code session.getNodeByIdentifier()} raises for an unknown id) is
 * still not a {@code BaseGqlClientException}, so it still comes back as the generic internal-error
 * message with the detail confined to the log. The wrapping constructor keeps the cause out of
 * {@code getMessage()} as well, so "Unable to read task creation date" is what ships, never the
 * underlying repository text. Every message in this module is written to be safe to show: it
 * states a rule or an outcome, never a path, a stack frame or a provider detail.
 *
 * <p>One consequence worth knowing: {@code JahiaDataFetchingExceptionHandler} only logs the
 * non-client branch, so these messages now go to the caller instead of to the server log.
 */
public class TaskGraphQLException extends DataFetchingException {

    private static final long serialVersionUID = 1L;

    public TaskGraphQLException(String message) {
        super(message);
    }

    public TaskGraphQLException(String message, Throwable cause) {
        super(message, cause);
    }
}
