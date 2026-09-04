package org.jahia.modules.tasks.graphql;

import graphql.annotations.annotationTypes.GraphQLDescription;
import graphql.annotations.annotationTypes.GraphQLField;
import graphql.annotations.annotationTypes.GraphQLName;
import org.jahia.services.content.JCRNodeWrapper;
import org.jahia.utils.i18n.JahiaLocaleContextHolder;

import javax.jcr.RepositoryException;

/**
 * One piece of content a task is about, named the way a reader recognises it.
 *
 * <p>The board used to show the raw JCR path of every target, which is what the content-types
 * module writes into a task's description and what {@code targetNode} exposes. A path is the wrong
 * thing to put in front of somebody: it is long, it repeats {@code /sites/&lt;site&gt;/} on every
 * row, and the part that identifies the content is a generated node name at the end
 * ({@code content_1754409576988}). This carries the display name and the type instead, plus where
 * to go to act on it.
 *
 * <p><b>Why this exists alongside {@code GqlTaskBoard#getTargetNode()}.</b> That field resolves a
 * target to its nearest containing PAGE, because only a page has a renderable URL - so for content
 * sitting inside a page it answers the page and the content itself is lost. Verified on a site: a
 * task on {@code /sites/luxe/legal/fees/main/page-header} answers {@code /sites/luxe/legal/fees}.
 * That is right for a preview link and useless for naming the content, so this type keeps the real
 * node and computes the navigation destination separately.
 */
public class GqlTaskTarget {

    private final JCRNodeWrapper node;
    private final JCRNodeWrapper containingPage;

    GqlTaskTarget(JCRNodeWrapper node) throws RepositoryException {
        this.node = node;
        this.containingPage = findAncestorPage(node);
    }

    /**
     * The nearest ANCESTOR that is a page, or null when the content does not sit in one.
     *
     * <p>Deliberately not {@code GqlTaskBoard#isRenderablePage}, which also matches
     * {@code jmix:mainResource}. That mixin means "has a URL of its own", which content in a
     * content folder routinely does - measured on a site, every {@code luxe:estate} and
     * {@code luxe:agency} under /contents matched it, so reusing that test reported all of them as
     * living in a page and sent "edit" to the content's own path. Only {@code jnt:page} answers the
     * question this type asks.
     *
     * <p>Starts at the parent, never the node: a page whose own task points at it is not "inside" a
     * page, and treating it as such would send somebody to the page above it.
     */
    private static JCRNodeWrapper findAncestorPage(JCRNodeWrapper node) throws RepositoryException {
        JCRNodeWrapper ancestor = node.getParent();
        while (true) {
            if (ancestor.isNodeType("jnt:page")) {
                return ancestor;
            }
            if ("/".equals(ancestor.getPath())) {
                return null;
            }
            ancestor = ancestor.getParent();
        }
    }

    @GraphQLField
    @GraphQLName("uuid")
    @GraphQLDescription("The target's identifier")
    public String getUuid() {
        try {
            return node.getIdentifier();
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read the target's identifier", e);
        }
    }

    @GraphQLField
    @GraphQLName("path")
    @GraphQLDescription("The target's JCR path -- for building a jContent location, not for display")
    public String getPath() {
        return node.getPath();
    }

    @GraphQLField
    @GraphQLName("displayName")
    @GraphQLDescription("What the content is called: its own display name, falling back to the node name")
    public String getDisplayName() {
        // getDisplayableName() is the same resolution jContent's own lists use: the node's title
        // where the type declares a primary item, and the node name where it does not. A generated
        // node name is still a poor label, but it is the only honest one for content with no title.
        String displayable = node.getDisplayableName();
        return (displayable == null || displayable.isEmpty()) ? node.getName() : displayable;
    }

    @GraphQLField
    @GraphQLName("typeName")
    @GraphQLDescription("The target's content type, in the reader's own language")
    public String getTypeName() {
        try {
            return node.getPrimaryNodeType().getLabel(JahiaLocaleContextHolder.getLocale());
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to read the target's content type", e);
        }
    }

    /**
     * Whether this content lives inside a page, which decides where "edit" should take somebody.
     *
     * <p>Content in a page is not editable on its own - it is a component of the page - so the
     * useful destination is jContent listing the page that holds it. Content in a content folder is
     * a standalone item, and the destination is the folder that holds it, where its own edit action
     * sits on the row.
     */
    @GraphQLField
    @GraphQLName("inPage")
    @GraphQLDescription("True when the target sits inside a page rather than in a content folder")
    public boolean isInPage() {
        return containingPage != null;
    }

    /**
     * Where to send somebody who wants to act on this content.
     *
     * <p>The containing page for content in a page, the parent folder otherwise. Never the node
     * itself: jContent lists the CHILDREN of the path it is given, so pointing at the content would
     * show what is inside it rather than the content among its siblings.
     */
    @GraphQLField
    @GraphQLName("locationPath")
    @GraphQLDescription("The jContent location that shows this content: its containing page, or its parent folder")
    public String getLocationPath() {
        try {
            if (containingPage != null) {
                return containingPage.getPath();
            }

            return node.getParent().getPath();
        } catch (RepositoryException e) {
            throw new TaskGraphQLException("Unable to resolve where the target can be edited", e);
        }
    }
}
