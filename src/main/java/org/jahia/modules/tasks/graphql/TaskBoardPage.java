package org.jahia.modules.tasks.graphql;

import org.jahia.modules.graphql.provider.dxm.relay.AbstractDXPaginatedData;
import org.jahia.modules.graphql.provider.dxm.relay.DXPaginatedData;
import org.jahia.modules.graphql.provider.dxm.relay.PaginationHelper;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Iterator;
import java.util.List;

/**
 * One already-sliced page of the task board, for the query-level fast path in
 * {@link TaskBoardQueryExtensions}.
 *
 * <p>Core's {@link PaginationHelper#paginate(java.util.stream.Stream,
 * org.jahia.modules.graphql.provider.dxm.relay.CursorSupport,
 * PaginationHelper.Arguments)} returns a paginated data whose {@code getTotalCount()} drains
 * whatever is left of the stream -- which, for a JCR-backed stream, means materializing every
 * remaining node just to count it. When the page can be sliced by the JCR query itself
 * (setOffset/setLimit), there is no stream left to drain: the page is a plain list and the total
 * is a separate, cheap count query, so this class simply carries both.
 *
 * <p>Field semantics are copied exactly from core's own {@code StreamBasedDXPaginatedData} so
 * that the two paths are observationally identical: {@code nodesCount} is the size of this page,
 * {@code totalCount} is the size of the whole result, {@code getIndex} is the row's absolute
 * (not page-relative) position, and hasPrevious/hasNext describe the page's neighbours.
 */
final class TaskBoardPage extends AbstractDXPaginatedData<GqlTaskBoard> {

    // Separates the absolute row index from the node identifier inside a fast-path cursor.
    // ':' is safe: node identifiers are UUIDs, so it can never occur in the id half.
    private static final char CURSOR_SEPARATOR = ':';

    private final List<GqlTaskBoard> items;
    private final int startOffset;

    TaskBoardPage(List<GqlTaskBoard> items, int startOffset, int totalCount, boolean hasPreviousPage,
            boolean hasNextPage) {
        super(items, hasPreviousPage, hasNextPage, items.size(), totalCount);
        this.items = items;
        this.startOffset = startOffset;
    }

    @Override
    public String getCursor(GqlTaskBoard task) {
        return encodeCursor(startOffset + items.indexOf(task), task.getId());
    }

    @Override
    public int getIndex(GqlTaskBoard task) {
        return startOffset + items.indexOf(task);
    }

    /**
     * The fast path's cursor: the node identifier, as the slow path emits, prefixed with the
     * row's absolute index. The index is what makes a subsequent {@code after:} request O(1) --
     * it becomes the JCR query's offset directly, instead of a scan from the first row looking
     * for a matching identifier. The identifier is kept so that offset can be *verified* rather
     * than trusted: {@link TaskBoardQueryExtensions} checks that the row actually sitting at that
     * offset is still the one the cursor was issued for, and falls back to the identifier scan
     * when the underlying data shifted underneath the client.
     */
    static String encodeCursor(int index, String id) {
        return PaginationHelper.encodeCursor(index + String.valueOf(CURSOR_SEPARATOR) + id);
    }

    /**
     * A bare identifier cursor -- the format this module emitted before indexes were added, and
     * still the one core's pagination is asked to <em>match</em> on. The scanning path hands core
     * this form (both as the {@code after}/{@code before} it compares against and as the cursor
     * it derives from each row), so that matching stays "find the row with this identifier" and
     * survives rows shifting; the index is added back on the way out by
     * {@link #withIndexedCursors}.
     */
    static String encodeCursor(String id) {
        return PaginationHelper.encodeCursor(id);
    }

    /**
     * Wraps a paginated result from core so that the cursors it publishes carry the row's
     * absolute index, exactly like the ones this class produces. Without it the scanning path
     * would emit index-less cursors, and a client that hit the scanning path once -- because it
     * was searching, or because a concurrent write invalidated one cursor -- could never get back
     * onto the fast path for the rest of its pagination.
     *
     * <p>Only the outward-facing cursor changes: core still matches on the bare identifier form
     * it was given, so nothing about how it locates a row is affected.
     */
    static DXPaginatedData<GqlTaskBoard> withIndexedCursors(DXPaginatedData<GqlTaskBoard> delegate) {
        return new IndexedCursors(delegate);
    }

    private static final class IndexedCursors implements DXPaginatedData<GqlTaskBoard> {

        private final DXPaginatedData<GqlTaskBoard> delegate;

        private IndexedCursors(DXPaginatedData<GqlTaskBoard> delegate) {
            this.delegate = delegate;
        }

        @Override
        public String getCursor(GqlTaskBoard task) {
            return encodeCursor(delegate.getIndex(task), task.getId());
        }

        @Override
        public int getIndex(GqlTaskBoard task) {
            return delegate.getIndex(task);
        }

        @Override
        public int getTotalCount() {
            return delegate.getTotalCount();
        }

        @Override
        public int getNodesCount() {
            return delegate.getNodesCount();
        }

        @Override
        public boolean hasNextPage() {
            return delegate.hasNextPage();
        }

        @Override
        public boolean hasPreviousPage() {
            return delegate.hasPreviousPage();
        }

        @Override
        public Iterator<GqlTaskBoard> iterator() {
            return delegate.iterator();
        }
    }

    /**
     * The absolute row index carried by {@code cursor}, or -1 when it carries none -- a bare
     * identifier cursor issued by the slow path, a cursor from a release before this format
     * existed, or anything else the client sent. -1 is not an error: it just means the fast path
     * cannot place this cursor and the request has to be served by the scanning path.
     */
    static int indexOf(String cursor) {
        String decoded = decode(cursor);
        int separator = decoded == null ? -1 : decoded.indexOf(CURSOR_SEPARATOR);
        if (separator <= 0) {
            return -1;
        }
        try {
            int index = Integer.parseInt(decoded.substring(0, separator));
            return index >= 0 ? index : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * The node identifier carried by {@code cursor}, whichever of the two formats it is in. Used
     * both to verify a fast-path offset and to normalize an index-bearing cursor back to the bare
     * identifier the slow path matches on, so that a client which switches sort or starts
     * searching mid-pagination keeps resuming from the right row instead of losing its place.
     */
    static String identifierOf(String cursor) {
        String decoded = decode(cursor);
        if (decoded == null) {
            return null;
        }
        int separator = decoded.indexOf(CURSOR_SEPARATOR);
        return separator < 0 ? decoded : decoded.substring(separator + 1);
    }

    private static String decode(String cursor) {
        if (cursor == null) {
            return null;
        }
        try {
            return new String(Base64.getDecoder().decode(cursor), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            // Not base64 at all -- a hand-written or corrupted cursor. Treated the same as a
            // cursor that simply doesn't match any row: the caller falls back rather than failing.
            return null;
        }
    }
}
