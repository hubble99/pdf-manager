from models.common import SuccessResponse, ErrorResponse

def test_success_response_valid():
    # Test default
    resp = SuccessResponse()
    assert resp.status == "success"
    assert resp.data is None
    assert resp.message is None

    # Test custom values
    resp_custom = SuccessResponse(status="custom_success", data={"foo": "bar"}, message="Hello")
    assert resp_custom.status == "custom_success"
    assert resp_custom.data == {"foo": "bar"}
    assert resp_custom.message == "Hello"

def test_error_response_valid():
    # Test message only
    resp = ErrorResponse(message="An error occurred")
    assert resp.status == "error"
    assert resp.message == "An error occurred"
    assert resp.detail is None

    # Test with detail
    resp_detail = ErrorResponse(message="Failed", detail="Additional error info")
    assert resp_detail.status == "error"
    assert resp_detail.message == "Failed"
    assert resp_detail.detail == "Additional error info"
