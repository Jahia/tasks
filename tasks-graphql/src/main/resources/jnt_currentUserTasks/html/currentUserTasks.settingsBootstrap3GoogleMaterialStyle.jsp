<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core" %>
<%@ taglib prefix="jcr" uri="http://www.jahia.org/tags/jcr" %>
<%@ taglib prefix="fmt" uri="http://java.sun.com/jsp/jstl/fmt" %>
<%@ taglib prefix="template" uri="http://www.jahia.org/tags/templateLib" %>
<%@ taglib prefix="fn" uri="http://java.sun.com/jsp/jstl/functions" %>
<%@ taglib prefix="workflow" uri="http://www.jahia.org/tags/workflow" %>
<%@ taglib prefix="uiComponents" uri="http://www.jahia.org/tags/uiComponentsLib" %>
<%@ taglib prefix="user" uri="http://www.jahia.org/tags/user" %>
<%@ taglib prefix="utility" uri="http://www.jahia.org/tags/utilityLib" %>
<%@ taglib prefix="functions" uri="http://www.jahia.org/tags/functions" %>
<%--@elvariable id="currentNode" type="org.jahia.services.content.JCRNodeWrapper"--%>
<%--@elvariable id="propertyDefinition" type="org.jahia.services.content.nodetypes.ExtendedPropertyDefinition"--%>
<%--@elvariable id="type" type="org.jahia.services.content.nodetypes.ExtendedNodeType"--%>
<%--@elvariable id="out" type="java.io.PrintWriter"--%>
<%--@elvariable id="script" type="org.jahia.services.render.scripting.Script"--%>
<%--@elvariable id="scriptInfo" type="java.lang.String"--%>
<%--@elvariable id="workspace" type="java.lang.String"--%>
<%--@elvariable id="renderContext" type="org.jahia.services.render.RenderContext"--%>
<%--@elvariable id="currentResource" type="org.jahia.services.render.Resource"--%>
<%--@elvariable id="url" type="org.jahia.services.render.URLGenerator"--%>
<%--@elvariable id="task" type="org.jahia.services.workflow.WorkflowTask"--%>
<template:addResources type="javascript" resources="jquery.min.js,jquery-ui.min.js,jquery.blockUI.js,bootstrap-filestyle.min.js,jquery.metadata.js,jquery.jeditable.js"/>
<template:addResources type="javascript" resources="datatables/jquery.dataTables.js,i18n/jquery.dataTables-${currentResource.locale}.js,datatables/dataTables.bootstrap-ext.js,settings/dataTables.initializer.js"/>
<template:addResources type="css" resources="datatables/css/bootstrap-theme.css,tablecloth.css,tasks.css"/>

<template:addResources type="javascript" resources="jquery.jeditable.ajaxupload.js"/>

<template:addResources type="javascript" resources="tasks.js"/>
<template:addResources type="javascript" resources="ajaxreplace.js"/>
<template:addResources type="javascript" resources="jquery.form.js"/>

<template:addResources>
    <script type="text/javascript">
        $(document).ready(function () {
            $(":file").filestyle({classButton: "btn", classIcon: "icon-folder-open"/*,buttonText:"Translation"*/});

            dataTablesSettings.init('userTasks_table', 25, []);

            /*$('#userTasks_table').dataTable({
                "sDom": "<'row'<'col-sm-6'l><'col-sm-6'f>r>t<'row'<'col-sm-6'i><'col-sm-6'p>>",
                "iDisplayLength": 25,
                "sPaginationType": "bootstrap",
                "aaSorting": [] //this option disable sort by default, the user steal can use column names to sort the table
            });*/
        });
    </script>
</template:addResources>
<div id="currentUserTasks${currentNode.identifier}">
    <div class="page-header">
        <h2>My Tasks</h2>
    </div>
    <c:if test="${currentResource.workspace eq 'live'}">
        <script type="text/javascript">
            $('#currentUserTasks${currentNode.identifier}').load('<c:url value="${url.baseUserBoardFrameEdit}${currentNode.path}.html.ajax"/>');
        </script>
    </c:if>

    <c:if test="${currentResource.workspace ne 'live'}">
        <c:set var="user" value="${uiComponents:getBindedComponent(currentNode, renderContext, 'j:bindedComponent')}"/>

        <c:if test="${empty user or not jcr:isNodeType(user, 'jnt:user')}">
            <jcr:node var="user" path="${renderContext.user.localPath}"/>
        </c:if>

        <form name="myform" method="post">
            <input type="hidden" name="jcrNodeType" value="jnt:task">
            <input type="hidden" name="jcrRedirectTo" value="<c:url value='${url.base}${renderContext.mainResource.node.path}'/>">
            <input type="hidden" name="jcrNewNodeOutputFormat" value="<c:url value='${renderContext.mainResource.template}.html'/>">
            <input type="hidden" name="state">
        </form>

        <script type="text/javascript">
            var ready = true;
            <c:url  var="reloadurl" value="${url.baseUserBoardFrameEdit}${currentNode.path}.html.ajax">
            <c:forEach items="${param}" var="p">
            <c:param name="${p.key}" value="${p.value}"/>
            </c:forEach>
            </c:url>
            <c:set var="identifierName" value="#currentUserTasks${currentNode.identifier}"/>

            callback = function (uuid) {
                    $('${identifierName}').load('${reloadurl}', null, function () {
                        $("#taskdetail_" + uuid).css("display", "block");
                        $("#iconTaskDisplayPlus_" + uuid).hide();
                        $("#iconTaskDisplayMinus_" + uuid).show();
                    });
            }

            function sendNewStatus(uuid, task, state, finalOutcome) {
                if (ready) {
                    ready = false;
                    $(".taskaction-complete").addClass("taskaction-disabled");
                    $(".taskaction").addClass("taskaction-disabled");
                    $.post('<c:url value="${url.basePreview}"/>' + task,
                            {"jcrMethodToCall": "put", "state": state, "finalOutcome": finalOutcome, "form-token": document.forms['tokenForm_' +
                            uuid].elements['form-token'].value}, callback(uuid) , "json");
                }
            }
            ;

            function sendNewAssignee(uuid, task, key) {
                if (ready) {
                    ready = false;
                    $(".taskaction-complete").addClass("taskaction-disabled");
                    $(".taskaction").addClass("taskaction-disabled");
                    $.post('<c:url value="${url.basePreview}"/>' + task,
                            {"jcrMethodToCall": "put", "state": "active", "assigneeUserKey": key, "form-token": document.forms['tokenForm_' +
                            uuid].elements['form-token'].value}, callback(uuid) , "json");
                }
            }
            ;

            function switchTaskDisplay(identifier) {
                $(".taskdetail").each(function () {
                    if (!$(this).is("#taskdetail_" + identifier)) {
                        $(this).slideUp("medium");
                        if ($("#iconTaskDisplay_" + identifier).hasClass("icon-plus")) {
                            $("#iconTaskDisplay_" + identifier).removeClass("icon-plus");
                            $("#iconTaskDisplay_" + identifier).addClass("icon-minus");
                        } else {
                            $(".iconTaskDisplay").removeClass("icon-minus");
                            $(".iconTaskDisplay").addClass("icon-plus");
                        }
                    }
                });

                $("#taskdetail_" + identifier).slideToggle("medium");
            }
            ;

            function switchDisplay(identifier) {
                if ($("#iconTaskDisplayPlus_" + identifier).is(":visible") == true) {
                    $("#iconTaskDisplayPlus_" + identifier).hide();
                    $("#iconTaskDisplayMinus_" + identifier).show();
                    $("#taskdetail_" + identifier).slideToggle("medium");
                } else if ($("#iconTaskDisplayMinus_" + identifier).is(":visible") == true) {
                    $("#iconTaskDisplayPlus_" + identifier).show();
                    $("#iconTaskDisplayMinus_" + identifier).hide();
                    $("#taskdetail_" + identifier).slideToggle("medium");
                }
            }

        </script>
        <template:include view="hidden.header"/>

        <div id="tasklist" class="panel panel-default" style="padding:15px">
                <div id="${user.UUID}">
                    <c:set value="${currentNode.properties['displayState'].boolean}" var="dispState"/>
                    <c:set value="${currentNode.properties['displayDueDate'].boolean}" var="dispDueDate"/>
                    <c:set value="${currentNode.properties['displayLastModifiedDate'].boolean}" var="dispLastModifiedDate"/>
                    <c:set value="${currentNode.properties['displayAssignee'].boolean}" var="dispAssignee"/>
                    <c:set value="${currentNode.properties['displayCreator'].boolean}" var="dispCreator"/>
                    <fieldset>
                        <table cellpadding="0" cellspacing="0" border="0" class="table table-hover table-striped" id="userTasks_table">
                            <thead>
                            <tr>
                                <th>
                                    <fmt:message key="mix_title.jcr_title"/>
                                </th>
                                <c:if test="${dispAssignee}">
                                    <th>
                                        <fmt:message key="label.owner"/>
                                    </th>
                                </c:if>
                                <c:if test="${dispCreator}">
                                    <th>
                                        <fmt:message key="mix_createdBy.jcr_createdBy"/>
                                    </th>
                                </c:if>
                                <c:if test="${dispState}">
                                    <th>
                                        <fmt:message key="jnt_task.state"/>
                                    </th>
                                </c:if>
                                <c:choose>
                                    <c:when test="${dispDueDate}">
                                        <th>
                                            <fmt:message key="jnt_task.dueDate"/>
                                        </th>
                                    </c:when>
                                    <c:when test="${dispLastModifiedDate}">
                                        <th>
                                            <fmt:message key="jnt_task.lastModifiedDate"/>
                                        </th>
                                    </c:when>
                                </c:choose>
                            </tr>
                            </thead>
                            <tbody>
                            <%@include file="userTasksTableRow.settingsBootstrap3GoogleMaterialStyle.jspf" %>
                            </tbody>
                        </table>
                    </fieldset>
                </div>
                <div class="clear"></div>
        </div>
        <template:include view="hidden.footer"/>
    </c:if>
</div>