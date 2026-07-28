<%@ taglib prefix="template" uri="http://www.jahia.org/tags/templateLib" %>
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="fn" uri="http://java.sun.com/jsp/jstl/functions" %>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt" %>

From task module
<template:tokenizedForm>
    <c:url value='${url.base}${currentNode.path}' var="url"/>
    <form id="taskDataForm_${currentNode.parent.identifier}" method="post" action="${url}">
        <input type="hidden" name="jcrMethodToCall" value="put"/>
        <div>
            <fmt:message key="label.title"/> : <input size="50" type="text" name="jcr:title"
                           value="${fn:escapeXml(currentNode.properties['jcr:title'].string)}"/>
        </div>
    </form>
</template:tokenizedForm>
