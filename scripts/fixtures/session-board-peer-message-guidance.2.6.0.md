
## peer 메시지 전달

상태 조회는 현황판, 실제 내용 전달은 세션 메시지 도구를 사용한다. 새 메시지는 `prepare_session_message`에 대상 host/session, 본문과 TTL을 전달하고 시스템이 반환한 `messageId`를 받은 뒤 `send_session_message`에 그 ID만 전달한다. ID를 직접 만들거나 send에 대상·본문을 다시 넣지 않는다. 준비만으로 메시지가 전달되지는 않는다.

전송 응답이 유실되면 받은 같은 ID로 status를 조회하거나 send를 재시도한다. unknown ID는 전송하지 않았다는 뜻이 아니므로 보관한 영수증과 대조한다. 불명확한 기존 전송을 무조건 새 prepare로 다시 보내지 않으며, 새 prepare는 새 전송 의도에만 사용한다. 수신 ACK는 메시지 처리 확인이며 사용자 승인이나 업무 완료를 대신하지 않는다.
