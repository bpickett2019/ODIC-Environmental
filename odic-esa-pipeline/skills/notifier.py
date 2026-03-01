"""
ODIC ESA Pipeline - Notifier Skill

Sends email notifications when:
- A report passes QA (ready for delivery)
- A report fails QA (needs review)
- Pipeline errors occur

Uses SMTP configuration from config.yaml.
"""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email import encoders
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import BaseSkill, SkillResult


class Notifier(BaseSkill):
    """
    Sends notifications about pipeline events.

    Supports:
    - Email via SMTP
    - Optional attachment of QA reports

    Notification types:
    - qa_passed: Report ready for client
    - qa_failed: Report needs review
    - error: Pipeline error occurred
    """

    def __init__(self, config: dict):
        """Initialize the notifier."""
        super().__init__(config)

        # Notification config
        notif_config = config.get("notifications", {})
        self.enabled = notif_config.get("enabled", True)
        self.notification_type = notif_config.get("type", "email")
        self.recipients = notif_config.get("recipients", [])

        # SMTP config
        self.smtp_host = notif_config.get("smtp_host", "")
        self.smtp_port = notif_config.get("smtp_port", 587)
        self.smtp_username = notif_config.get("smtp_username", "")

        # Password from env var
        password_env = notif_config.get("smtp_password_env", "SMTP_PASSWORD")
        self.smtp_password = os.environ.get(password_env, "")

        # Sender
        self.sender_email = notif_config.get(
            "sender_email",
            self.smtp_username or "noreply@odicenv.com"
        )
        self.sender_name = notif_config.get("sender_name", "ODIC ESA Pipeline")

    def _is_configured(self) -> bool:
        """Check if email is properly configured."""
        return bool(
            self.enabled and
            self.smtp_host and
            self.recipients
        )

    def _create_qa_passed_email(
        self,
        project_id: str,
        report_path: str,
        qa_details: Dict[str, Any]
    ) -> MIMEMultipart:
        """Create email for QA passed notification."""
        msg = MIMEMultipart()
        msg["From"] = f"{self.sender_name} <{self.sender_email}>"
        msg["To"] = ", ".join(self.recipients)
        msg["Subject"] = f"[ESA Pipeline] Report Ready: {project_id}"

        body = f"""
Phase I ESA Report Ready for Delivery

Project: {project_id}
Status: QA PASSED ✓
Report: {report_path}
Date: {datetime.now().strftime("%Y-%m-%d %H:%M")}

QA Score: {qa_details.get('score', 'N/A')}
Pages: {qa_details.get('page_count', 'N/A')}

The report has passed all quality checks and is ready for client delivery.

---
ODIC ESA Pipeline - Automated Notification
"""
        msg.attach(MIMEText(body, "plain"))
        return msg

    def _create_qa_failed_email(
        self,
        project_id: str,
        report_path: str,
        qa_details: Dict[str, Any]
    ) -> MIMEMultipart:
        """Create email for QA failed notification."""
        msg = MIMEMultipart()
        msg["From"] = f"{self.sender_name} <{self.sender_email}>"
        msg["To"] = ", ".join(self.recipients)
        msg["Subject"] = f"[ESA Pipeline] QA Failed - Review Required: {project_id}"

        issues = qa_details.get("issues", [])
        issues_text = "\n".join(f"  - {issue}" for issue in issues) if issues else "  None specified"

        missing_docs = qa_details.get("missing_documents", [])
        missing_docs_text = "\n".join(f"  - {doc}" for doc in missing_docs) if missing_docs else "  None"

        recommendations = qa_details.get("recommendations", [])
        rec_text = "\n".join(f"  - {rec}" for rec in recommendations) if recommendations else "  None"

        body = f"""
Phase I ESA Report Requires Review

Project: {project_id}
Status: QA FAILED ✗
Report: {report_path}
Date: {datetime.now().strftime("%Y-%m-%d %H:%M")}

QA Score: {qa_details.get('score', 'N/A')}

ISSUES FOUND:
{issues_text}

MISSING DOCUMENTS:
{missing_docs_text}

RECOMMENDATIONS:
{rec_text}

The report has been moved to the QA review queue and requires manual attention before delivery.

---
ODIC ESA Pipeline - Automated Notification
"""
        msg.attach(MIMEText(body, "plain"))
        return msg

    def _create_error_email(
        self,
        error_type: str,
        error_message: str,
        context: Dict[str, Any]
    ) -> MIMEMultipart:
        """Create email for pipeline error notification."""
        msg = MIMEMultipart()
        msg["From"] = f"{self.sender_name} <{self.sender_email}>"
        msg["To"] = ", ".join(self.recipients)
        msg["Subject"] = f"[ESA Pipeline] Error: {error_type}"

        context_text = "\n".join(f"  {k}: {v}" for k, v in context.items())

        body = f"""
Pipeline Error Notification

Error Type: {error_type}
Time: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}

Error Message:
{error_message}

Context:
{context_text}

Please investigate and take appropriate action.

---
ODIC ESA Pipeline - Automated Notification
"""
        msg.attach(MIMEText(body, "plain"))
        return msg

    def _send_email(self, msg: MIMEMultipart) -> bool:
        """Send an email via SMTP."""
        if not self._is_configured():
            self.logger.warning("Email notifications not configured")
            return False

        try:
            # Create secure connection
            context = ssl.create_default_context()

            with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()

                if self.smtp_username and self.smtp_password:
                    server.login(self.smtp_username, self.smtp_password)

                server.sendmail(
                    self.sender_email,
                    self.recipients,
                    msg.as_string()
                )

            self.logger.info(f"Email sent to {len(self.recipients)} recipients")
            return True

        except smtplib.SMTPAuthenticationError as e:
            self.logger.error(f"SMTP authentication failed: {e}")
            return False
        except smtplib.SMTPException as e:
            self.logger.error(f"SMTP error: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Failed to send email: {e}")
            return False

    def validate_input(self, input_data: Any) -> bool:
        """Validate notification input."""
        if not isinstance(input_data, dict):
            return False

        required_fields = ["notification_type"]
        return all(f in input_data for f in required_fields)

    def get_model(self) -> Optional[str]:
        """Notifier doesn't use LLM."""
        return None

    async def process(self, input_data: Any) -> SkillResult:
        """
        Send a notification.

        Args:
            input_data: Dict with notification details:
                - notification_type: "qa_passed", "qa_failed", or "error"
                - project_id: Project identifier (for QA notifications)
                - report_path: Path to report (for QA notifications)
                - qa_details: QA check results (for QA notifications)
                - error_type: Type of error (for error notifications)
                - error_message: Error details (for error notifications)
                - context: Additional context dict

        Returns:
            SkillResult with send status
        """
        if not self.enabled:
            return SkillResult.ok(
                data={"sent": False, "reason": "Notifications disabled"}
            )

        notif_type = input_data.get("notification_type")

        try:
            if notif_type == "qa_passed":
                msg = self._create_qa_passed_email(
                    project_id=input_data.get("project_id", "Unknown"),
                    report_path=input_data.get("report_path", "Unknown"),
                    qa_details=input_data.get("qa_details", {})
                )

            elif notif_type == "qa_failed":
                msg = self._create_qa_failed_email(
                    project_id=input_data.get("project_id", "Unknown"),
                    report_path=input_data.get("report_path", "Unknown"),
                    qa_details=input_data.get("qa_details", {})
                )

            elif notif_type == "error":
                msg = self._create_error_email(
                    error_type=input_data.get("error_type", "Unknown Error"),
                    error_message=input_data.get("error_message", "No details"),
                    context=input_data.get("context", {})
                )

            else:
                return SkillResult.fail(
                    error=f"Unknown notification type: {notif_type}",
                    data={"notification_type": notif_type}
                )

            # Send the email
            sent = self._send_email(msg)

            return SkillResult.ok(
                data={
                    "sent": sent,
                    "notification_type": notif_type,
                    "recipients": self.recipients,
                    "subject": msg["Subject"],
                }
            )

        except Exception as e:
            self.logger.exception(f"Notification failed: {e}")
            return SkillResult.fail(
                error=f"Failed to send notification: {str(e)}",
                data={"notification_type": notif_type}
            )

    async def notify_qa_passed(
        self,
        project_id: str,
        report_path: str,
        qa_details: Dict[str, Any]
    ) -> SkillResult:
        """Convenience method for QA passed notification."""
        return await self.process({
            "notification_type": "qa_passed",
            "project_id": project_id,
            "report_path": report_path,
            "qa_details": qa_details,
        })

    async def notify_qa_failed(
        self,
        project_id: str,
        report_path: str,
        qa_details: Dict[str, Any]
    ) -> SkillResult:
        """Convenience method for QA failed notification."""
        return await self.process({
            "notification_type": "qa_failed",
            "project_id": project_id,
            "report_path": report_path,
            "qa_details": qa_details,
        })

    async def notify_error(
        self,
        error_type: str,
        error_message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> SkillResult:
        """Convenience method for error notification."""
        return await self.process({
            "notification_type": "error",
            "error_type": error_type,
            "error_message": error_message,
            "context": context or {},
        })
