"""
ODIC ESA Pipeline - Document Classifier Tests

Tests the document classifier against mock PDF content for each document type.
Uses actual LLM calls to verify classification accuracy.
"""

import os
import sys
import pytest
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from skills.document_classifier import DocumentClassifier
from skills.base import SkillResult


# Mock document content for each document type
MOCK_DOCUMENTS = {
    "sanborn_map": {
        "text": """
        SANBORN MAP COMPANY
        FIRE INSURANCE MAP

        City of Springfield, Illinois
        Volume 2, Sheet 145
        Published 1925, Updated 1950

        Scale: 50 feet to an inch

        [Map showing building footprints]

        Legend:
        - Brick construction (pink)
        - Frame construction (yellow)
        - Stone/concrete (blue)

        Building materials noted:
        - 2-story brick commercial
        - Fire walls indicated
        - Sprinkler systems marked

        Streets: Main Street, Oak Avenue
        Property at 123 Main Street
        Former dry goods store
        Current: vacant warehouse
        """,
        "expected_type": "sanborn_map",
        "min_confidence": 0.85,
    },
    "topographic_map": {
        "text": """
        UNITED STATES GEOLOGICAL SURVEY
        DEPARTMENT OF THE INTERIOR

        SPRINGFIELD QUADRANGLE
        ILLINOIS
        7.5 MINUTE SERIES (TOPOGRAPHIC)

        Scale 1:24,000
        Contour Interval 10 feet

        Datum: North American Vertical Datum 1988

        Features shown:
        - Elevation contours
        - Water bodies
        - Roads and highways
        - Buildings and structures
        - Vegetation areas

        UTM Grid Zone 16
        State Plane Coordinates

        Magnetic declination 2° West

        Survey Date: 1985
        Photo Revised: 1998
        """,
        "expected_type": "topographic_map",
        "min_confidence": 0.85,
    },
    "aerial_photograph": {
        "text": """
        AERIAL PHOTOGRAPH

        Flight Date: June 15, 1975
        Flight Line: 23
        Photo Number: 147

        Scale: 1:20,000

        Coverage Area: Springfield Industrial District

        Visible Features:
        - Industrial buildings
        - Storage tanks
        - Parking areas
        - Railroad tracks
        - Wooded areas to the east

        Photo Source: USDA Farm Service Agency
        Negative Number: FSA-75-23-147

        North arrow indicated
        Photo center coordinates: 39.7817° N, 89.6501° W
        """,
        "expected_type": "aerial_photograph",
        "min_confidence": 0.85,
    },
    "city_directory": {
        "text": """
        POLK'S CITY DIRECTORY
        Springfield, Illinois
        1965 Edition

        R.L. Polk & Co., Publishers

        STREET GUIDE - MAIN STREET

        100 Block:
        101 - Smith Hardware Co.
        103 - vacant
        105 - Johnson's Dry Cleaning
        107 - First National Bank

        123 - SPRINGFIELD CHEMICAL SUPPLY
              Wholesale chemicals and solvents
              John H. Wilson, proprietor
              Employees: 12
              Est. 1948

        125 - Miller's Drug Store
        127 - City Barber Shop

        CLASSIFIED BUSINESS DIRECTORY
        Chemicals - Wholesale:
        Springfield Chemical Supply, 123 Main...555-1234
        """,
        "expected_type": "city_directory",
        "min_confidence": 0.85,
    },
    "edr": {
        "text": """
        ENVIRONMENTAL DATA RESOURCES, INC.
        The Standard in Environmental Risk Information

        EDR RADIUS MAP REPORT

        Site Name: Springfield Industrial Property
        Address: 123 Main Street, Springfield, IL 62701

        Report Date: January 15, 2024
        Inquiry Number: 12345678.2s

        DATABASE SEARCH RESULTS

        Federal Records:
        CERCLIS/SEMS - No sites found within 0.5 miles
        RCRA-TSDF - 1 site found within 0.5 miles
        RCRA-LQG - 2 sites found within 0.25 miles

        State Records:
        LUST - 3 sites found within 0.5 miles
        UST - 5 sites found within 0.25 miles
        VCP - No sites found

        Orphan Summary:
        4 orphan sites identified

        Radius Map included

        EDR certification statement included
        """,
        "expected_type": "edr",
        "min_confidence": 0.90,
    },
    "title_record": {
        "text": """
        WARRANTY DEED

        Document Number: 2020-R-12345
        Recording Date: March 15, 2020

        GRANTOR: ABC Holdings, LLC
                 a Delaware limited liability company

        GRANTEE: XYZ Development Corp.
                 an Illinois corporation

        LEGAL DESCRIPTION:
        Lot 5 in Block 12 of Smith's Addition to the
        City of Springfield, Sangamon County, Illinois,
        according to the plat thereof recorded in
        Plat Book 5, Page 123.

        Commonly known as: 123 Main Street, Springfield, IL

        PIN: 14-28-301-005

        Consideration: $1,500,000.00

        [Notary acknowledgment and signatures]

        Chain of Title Reference:
        Prior deed recorded 1998-R-56789
        """,
        "expected_type": "title_record",
        "min_confidence": 0.85,
    },
    "building_permit": {
        "text": """
        CITY OF SPRINGFIELD
        BUILDING DEPARTMENT

        BUILDING PERMIT

        Permit Number: BP-2019-4567
        Issue Date: August 10, 2019

        Property Address: 123 Main Street

        Owner: XYZ Development Corp.
        Contractor: Smith Construction, Inc.
        License #: CC-12345

        Project Description:
        Interior renovation of existing warehouse
        building for conversion to office space.
        Installation of new HVAC system.
        Electrical upgrade to 400 amp service.

        Estimated Cost: $450,000
        Square Footage: 15,000 sq ft

        Inspections Required:
        - Rough electrical
        - Rough plumbing
        - Framing
        - Final

        Certificate of Occupancy: Pending
        """,
        "expected_type": "building_permit",
        "min_confidence": 0.85,
    },
    "site_photograph": {
        "text": """
        SITE PHOTOGRAPH LOG

        Project: Phase I ESA - 123 Main Street
        Project Number: ODIC-2024-001

        Site Visit Date: January 20, 2024
        Weather: Sunny, 45°F

        Photographer: John Smith, P.E.

        Photo 1: Front (north) elevation of building
                 Direction: Looking south
                 Features: Main entrance, loading dock

        Photo 2: Rear (south) elevation
                 Direction: Looking north
                 Features: Storage area, dumpsters

        Photo 3: Interior - Main floor
                 Features: Open warehouse space, concrete floor
                 Staining noted near south wall

        Photo 4: AST area
                 Features: Two 500-gallon ASTs
                 Contents: Heating oil
                 Secondary containment present

        Photo 5: Adjacent property (east)
                 Features: Active gas station
        """,
        "expected_type": "site_photograph",
        "min_confidence": 0.85,
    },
    "regulatory_correspondence": {
        "text": """
        UNITED STATES ENVIRONMENTAL PROTECTION AGENCY
        REGION 5
        77 West Jackson Boulevard
        Chicago, Illinois 60604

        January 5, 2024

        RE: RCRA Compliance Inspection
            Springfield Chemical Supply
            123 Main Street
            Springfield, IL 62701
            EPA ID: ILD123456789

        Dear Property Owner:

        On December 15, 2023, representatives of the U.S. EPA
        conducted a compliance evaluation inspection at the
        above-referenced facility.

        The inspection revealed the following violations of
        the Resource Conservation and Recovery Act (RCRA):

        1. Failure to maintain proper hazardous waste
           manifests (40 CFR 262.40)

        2. Inadequate secondary containment for waste
           storage area (40 CFR 264.175)

        Please submit a corrective action plan within 30 days.

        Sincerely,
        Environmental Protection Agency
        """,
        "expected_type": "regulatory_correspondence",
        "min_confidence": 0.85,
    },
    "prior_environmental_report": {
        "text": """
        PHASE I ENVIRONMENTAL SITE ASSESSMENT

        PRIOR ESA REPORT - PREVIOUSLY COMPLETED

        Prepared for:
        ABC Development Company

        Site Address:
        123 Main Street
        Springfield, Illinois 62701

        Prepared by:
        ODIC Environmental Consulting, Inc.

        Project Number: ODIC-2018-456

        Report Date: March 15, 2018

        EXECUTIVE SUMMARY

        ODIC Environmental has completed a prior Phase I
        Environmental Site Assessment (ESA) of the
        property located at 123 Main Street in accordance
        with ASTM E1527-13.

        This prior report documents the previous assessment
        conducted by ODIC for this same property.

        FINDINGS:

        1. Historical use as chemical distribution facility
           (1948-1995)

        2. Two underground storage tanks removed in 1996

        3. Adjacent LUST site with documented groundwater
           contamination migrating toward subject property

        RECOMMENDATIONS:
        Phase II ESA recommended to assess potential impacts
        """,
        "expected_type": "prior_environmental_report",
        "min_confidence": 0.85,
    },
    "lab_results": {
        "text": """
        ANALYTICAL LABORATORY REPORT

        TestLab Environmental Services
        NELAP Certification #: IL100123

        Client: ODIC Environmental Consulting
        Project: Springfield Phase II
        Project Number: ODIC-2024-002

        Sample Information:
        Sample ID: SB-1 (2-4 ft)
        Matrix: Soil
        Collection Date: February 1, 2024
        Receipt Date: February 2, 2024

        VOLATILE ORGANIC COMPOUNDS (EPA 8260B)

        Analyte              Result    Units    MDL    RL
        Benzene              0.015     mg/kg    0.005  0.010
        Toluene              0.045     mg/kg    0.005  0.010
        Ethylbenzene         ND        mg/kg    0.005  0.010
        Xylenes (total)      0.089     mg/kg    0.010  0.020

        PETROLEUM HYDROCARBONS (EPA 8015)

        DRO                  125       mg/kg    10     25
        GRO                  45        mg/kg    5      10

        QA/QC Summary attached
        Chain of Custody attached
        """,
        "expected_type": "lab_results",
        "min_confidence": 0.85,
    },
    "client_correspondence": {
        "text": """
        From: john.smith@abcdevelopment.com
        To: consultant@odicenv.com
        Date: January 10, 2024
        Subject: Phase I ESA Request - 123 Main Street

        Dear ODIC Environmental,

        We are under contract to purchase the property at
        123 Main Street, Springfield, IL 62701. Our lender
        requires a Phase I Environmental Site Assessment
        prior to closing.

        Closing is scheduled for March 1, 2024.

        Property Information:
        - Current owner: XYZ Development Corp.
        - Parcel size: 2.5 acres
        - Current use: Vacant warehouse
        - Historical use: Chemical distribution (per seller)

        Please provide a proposal and timeline.

        Authorization to proceed with the assessment
        is granted upon receipt of your proposal.

        Best regards,
        John Smith
        Vice President, Acquisitions
        ABC Development Company
        """,
        "expected_type": "client_correspondence",
        "min_confidence": 0.85,
    },
    "tax_record": {
        "text": """
        SANGAMON COUNTY ASSESSOR'S OFFICE
        PROPERTY TAX RECORD

        Tax Year: 2023

        Property Identification Number (PIN): 14-28-301-005

        Property Address: 123 Main Street
                         Springfield, IL 62701

        Owner of Record: XYZ Development Corp.
                        456 Corporate Drive
                        Chicago, IL 60601

        Legal Description:
        Lot 5 in Block 12 of Smith's Addition

        Property Classification: Commercial/Industrial

        Assessment:
        Land Value:        $150,000
        Improvement Value: $350,000
        Total EAV:         $500,000

        Tax Rate: 8.5%
        Estimated Tax: $42,500

        Property History:
        2022 - XYZ Development Corp.
        2020 - ABC Holdings, LLC
        1995 - Springfield Chemical Supply
        """,
        "expected_type": "tax_record",
        "min_confidence": 0.85,
    },
}


# Test configuration
TEST_CONFIG = {
    "llm": {
        "api_key_env": "ANTHROPIC_API_KEY",
        "classifier_model": "claude-haiku-4-5-20251001",
        "reasoning_model": "claude-sonnet-4-5-20250929",
        "max_retries": 3,
        "timeout_seconds": 60,
    },
    "pipeline": {
        "confidence_threshold": 0.90,
    },
    "debug": True,
}


@pytest.fixture
def classifier():
    """Create a document classifier instance."""
    return DocumentClassifier(TEST_CONFIG)


@pytest.fixture
def api_available():
    """Check if Kimi K2.5 API is available (Moonshot AI)."""
    api_key = os.environ.get("MOONSHOT_API_KEY") or os.environ.get("KIMI_API_KEY")
    # Note: Tests work with rule-based fallback when API is not available
    # This fixture is optional - just indicates if real AI calls are available
    return api_key is not None


class TestDocumentClassifier:
    """Test suite for DocumentClassifier."""

    def test_classifier_initialization(self, classifier):
        """Test that classifier initializes correctly."""
        assert classifier is not None
        assert classifier.confidence_threshold == 0.90
        assert classifier.document_types is not None
        assert "document_types" in classifier.document_types

    def test_document_types_loaded(self, classifier):
        """Test that document types are loaded from config."""
        doc_types = classifier.document_types.get("document_types", {})
        assert len(doc_types) > 0

        # Check for expected document types
        expected_types = [
            "sanborn_map",
            "topographic_map",
            "aerial_photograph",
            "edr",
            "site_photograph",
        ]
        for doc_type in expected_types:
            assert doc_type in doc_types, f"Missing document type: {doc_type}"

    def test_format_document_types_for_prompt(self, classifier):
        """Test document types formatting for prompt."""
        formatted = classifier._format_document_types_for_prompt()
        assert len(formatted) > 0
        assert "sanborn_map" in formatted
        assert "Description:" in formatted

    def test_project_id_extraction(self, classifier):
        """Test project ID extraction from filenames."""
        test_cases = [
            ("ODIC-2024-001_sanborn.pdf", "ODIC-2024-001"),
            ("PROJECT-123_report.pdf", "PROJECT-123"),
            ("2024-001_aerial.pdf", "2024-001"),
            ("random_file.pdf", None),
        ]

        for filename, expected_id in test_cases:
            result = classifier._extract_project_id_from_filename(filename)
            assert result == expected_id, f"Failed for {filename}"

    def test_validate_input_with_invalid_type(self, classifier):
        """Test input validation with wrong type."""
        assert classifier.validate_input(123) is False
        assert classifier.validate_input(None) is False
        assert classifier.validate_input(["file.pdf"]) is False

    def test_validate_input_with_nonexistent_file(self, classifier):
        """Test input validation with non-existent file."""
        assert classifier.validate_input("/nonexistent/path/file.pdf") is False

    def test_validate_input_with_non_pdf(self, classifier, tmp_path):
        """Test input validation with non-PDF file."""
        txt_file = tmp_path / "test.txt"
        txt_file.write_text("test content")
        assert classifier.validate_input(str(txt_file)) is False

    def test_parse_llm_response_valid_json(self, classifier):
        """Test LLM response parsing with valid JSON."""
        response = '{"document_type": "edr", "confidence": 0.95, "reasoning": "test"}'
        parsed = classifier._parse_llm_response(response)

        assert parsed["document_type"] == "edr"
        assert parsed["confidence"] == 0.95

    def test_parse_llm_response_json_with_extra_text(self, classifier):
        """Test LLM response parsing with extra text around JSON."""
        response = 'Here is the classification:\n{"document_type": "edr", "confidence": 0.95, "reasoning": "test"}\nEnd.'
        parsed = classifier._parse_llm_response(response)

        assert parsed["document_type"] == "edr"

    def test_parse_llm_response_invalid_json(self, classifier):
        """Test LLM response parsing with invalid JSON."""
        response = "This is not JSON at all"
        parsed = classifier._parse_llm_response(response)

        assert parsed["document_type"] == "other"
        assert parsed["confidence"] == 0.0

    def test_get_model(self, classifier):
        """Test that classifier returns correct model (Kimi K2.5)."""
        model = classifier.get_model()
        # Model can be either haiku (original) or kimi-k2.5 (new)
        assert "haiku" in model.lower() or "kimi" in model.lower()


# Integration tests that call the actual LLM
@pytest.mark.asyncio
class TestClassifierIntegration:
    """Integration tests that call the actual Anthropic API."""

    @pytest.mark.parametrize(
        "doc_type,mock_data",
        list(MOCK_DOCUMENTS.items()),
        ids=list(MOCK_DOCUMENTS.keys()),
    )
    async def test_classify_document_type(
        self, classifier, api_available, doc_type, mock_data
    ):
        """
        Test classification of each document type.

        This test calls the actual LLM API with mock document content
        and verifies the classification result.
        """
        result = await classifier.classify_text(
            text=mock_data["text"],
            filename=f"ODIC-2024-001_{doc_type}.pdf",
        )

        # Check result structure
        assert isinstance(result, SkillResult)
        assert result.success is True, f"Classification failed: {result.error}"
        assert result.data is not None

        # Check classification
        classified_type = result.data["type"]
        confidence = result.data["confidence"]

        print(f"\n{doc_type}:")
        print(f"  Classified as: {classified_type}")
        print(f"  Confidence: {confidence:.2f}")
        print(f"  Reasoning: {result.data.get('reasoning', 'N/A')[:100]}...")

        # Verify classification matches expected type
        assert (
            classified_type == mock_data["expected_type"]
        ), f"Expected {mock_data['expected_type']}, got {classified_type}"

        # Verify confidence meets minimum threshold
        assert (
            confidence >= mock_data["min_confidence"]
        ), f"Confidence {confidence:.2f} below threshold {mock_data['min_confidence']}"

    async def test_ambiguous_document_flags_for_review(
        self, classifier, api_available
    ):
        """Test that ambiguous documents are flagged for manual review."""
        ambiguous_text = """
        Document Fragment

        This document contains some text but is unclear
        what type of document it is. It could be various
        things. There are no clear identifying features.

        Some random numbers: 123-456
        A date: January 2024
        """

        result = await classifier.classify_text(
            text=ambiguous_text,
            filename="unknown_document.pdf",
        )

        assert result.success is True
        # Either classified as 'other' or low confidence should trigger review
        if result.data["type"] == "other" or result.data["confidence"] < 0.90:
            assert result.data["requires_manual_review"] is True

    async def test_classification_extracts_metadata(self, classifier, api_available):
        """Test that classifier extracts metadata from documents."""
        edr_text = MOCK_DOCUMENTS["edr"]["text"]

        result = await classifier.classify_text(
            text=edr_text,
            filename="ODIC-2024-001_edr_report.pdf",
        )

        assert result.success is True

        # Check that project ID was extracted
        assert result.data["project_id"] is not None

        # Check metadata extraction
        metadata = result.data.get("extracted_metadata", {})
        # EDR typically has dates and locations
        print(f"\nExtracted metadata: {metadata}")


# Run tests if executed directly
if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
