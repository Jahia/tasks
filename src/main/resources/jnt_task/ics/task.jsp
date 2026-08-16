<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt"%>
<%@ taglib prefix="jcr" uri="http://www.jahia.org/tags/jcr" %>
<%--@elvariable id="currentNode" type="org.jahia.services.content.JCRNodeWrapper"--%>
<%--@elvariable id="renderContext" type="org.jahia.services.render.RenderContext"--%>
<%--@elvariable id="url" type="org.jahia.services.render.URLGenerator"--%>
<%@ page import="org.jahia.registries.ServicesRegistry"%>
<%@ page import="org.jahia.services.content.JCRNodeWrapper"%>
<%@ page import="org.jahia.services.usermanager.JahiaUser"%>
<%@ page import="org.jahia.services.usermanager.JahiaUserManagerService"%>
<%@ page import="java.util.HashMap" %>
<%@ page import="javax.jcr.RepositoryException" %>
<%@ page import="org.jahia.services.content.decorator.JCRUserNode" %>
<%--
    Every content line below is written with its newline LEADING it ("\nSUMMARY:...") rather than
    trailing it, and the same goes for the lines this scriptlet returns. That is not a style
    choice: the JSP engine that compiles module JSPs drops template text nodes made up entirely of
    whitespace, so a newline sitting between a "${...}" and the next custom action -- which is what
    a trailing newline is, once JSTL tags are involved -- is deleted before it reaches the output.
    Written the other way round, each newline is part of a text node that also carries the next
    property name, so nothing can trim it, and the file stays a valid iCalendar object instead of
    collapsing into "SUMMARY:...DESCRIPTION:...DUE:..." on one line (#66).

    STATUS is mapped from the task's own state, and only from it. This view used to emit
    STATUS:CANCELLED for any task with no assignee, before looking at the state at all -- which
    made every unclaimed task export as a cancelled to-do (calendar clients strike those through or
    hide them outright), and left the state jnt:task actually calls "cancelled" with no mapping of
    its own. Now that the task board links to this view for every task with a due date (#66), that
    is the common case, not an edge one: an unassigned active task is NEEDS-ACTION, which is
    exactly what iCalendar's own vocabulary means by it.
--%>
<%!
    String getUserContentLine(JCRUserNode user, String contentLineName) throws RepositoryException {
        if (user != null) {
            String email = user.getPropertyAsString("j:email");
            if (email != null && !"".equals(email)) {
                String contentLine = contentLineName;
                String firstName = user.getPropertyAsString("j:firstName");
                String lastName = user.getPropertyAsString("j:lastName");
                boolean hasFirstName = firstName != null && !"".equals(firstName);
                boolean hasLastName = lastName != null && !"".equals(lastName);
                if (hasFirstName || hasLastName) {
                    contentLine += ";CN=";
                    if (hasFirstName) {
                        contentLine += firstName;
                        if (hasLastName) {
                            contentLine += " ";
                        }
                    }
                    if (hasLastName) {
                        contentLine += lastName;
                    }
                }
                return "\n" + contentLine + ":MAILTO:" + email;
            }

        }
        return "";
    }
%>
<%
    HashMap<String, Integer> priorities = new HashMap<String, Integer>();
    priorities.put("low", 9);
    priorities.put("normal", 5);
    priorities.put("high", 1);
    pageContext.setAttribute("priorities", priorities);
%>
<c:set target="${renderContext}" property="contentType" value="text/calendar;charset=UTF-8" />BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO<c:if test="${not empty currentNode.properties['assigneeUserKey'].string}"><jcr:node var="assigneeNode" path="${currentNode.properties['assigneeUserKey'].string}"/></c:if><%= getUserContentLine((JCRUserNode)pageContext.getAttribute("assigneeNode"), "ATTENDEE")%><c:if test="${not empty currentNode.properties['priority'].string}">
PRIORITY:${priorities[currentNode.properties['priority'].string]}</c:if><c:set var="creatorNode" value="${jcr:getParentOfType(currentNode,'jnt:user')}" /><%= getUserContentLine((JCRUserNode)pageContext.getAttribute("creatorNode"), "ORGANIZER")%>
DTSTAMP:<fmt:formatDate value="${currentNode.properties['jcr:created'].date.time}" pattern="yyyyMMdd'T'HHmmss'Z'" timeZone="GMT" />
URL;VALUE=URI:<c:url value="${url.server}${url.context}${url.baseLive}${renderContext.user.localPath}.user-tasks.html"/>
SUMMARY:${currentNode.properties['jcr:title'].string}<c:if test="${not empty currentNode.properties['description'].string}">
DESCRIPTION:${currentNode.properties['description'].string}</c:if>
DUE:<fmt:formatDate value="${currentNode.properties['dueDate'].date.time}" pattern="yyyyMMdd'T'HHmmss'Z'" timeZone="GMT" /><c:choose><c:when test="${currentNode.properties['state'].string eq 'active'}">
STATUS:NEEDS-ACTION</c:when><c:when test="${currentNode.properties['state'].string eq 'started'}">
STATUS:IN-PROCESS</c:when><c:when test="${currentNode.properties['state'].string eq 'finished'}">
STATUS:COMPLETED</c:when><c:when test="${currentNode.properties['state'].string eq 'cancelled'}">
STATUS:CANCELLED</c:when></c:choose>
END:VTODO
END:VCALENDAR
